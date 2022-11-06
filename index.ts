import config from "./config";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  obtainDiasendAccessToken,
  getPatientData,
  GlucoseRecord,
  CarbRecord,
  BolusRecord,
  getPumpSettings,
  getAuthenticatedScrapingClient,
  BasalRecord,
  PatientRecord,
  PatientRecordWithDeviceData,
} from "./diasend";
import {
  reportEntriesToNightscout,
  MealBolusTreatment,
  reportTreatmentsToNightscout,
  Treatment,
  CorrectionBolusTreatment,
  Entry,
  Profile,
  fetchProfile,
  updateProfile,
  ProfileConfig,
  CarbCorrectionTreatment,
} from "./nightscout";
import {
  diasendRecordToNightscoutTreatment,
  diasendGlucoseRecordToNightscoutEntry,
  updateBasalProfile,
  updateNightScoutProfileWithPumpSettings,
} from "./adapter";
import { Looper } from "./Looper";

dayjs.extend(relativeTime);

interface BaseSyncDiasendArgs {
  diasendUsername?: string;
  diasendPassword?: string;
  diasendClientId?: string;
  diasendClientSecret?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

interface SyncDiasendGlucoseToNightscoutArgs extends BaseSyncDiasendArgs {
  nightscoutEntriesHandler?: (entries: Entry[]) => Promise<Entry[]>;
}

interface SyncDiasendDataToNightScoutArgs extends BaseSyncDiasendArgs {
  nightscoutProfileName?: string;
  nightscoutTreatmentsHandler?: (
    treatments: Treatment[]
  ) => Promise<Treatment[]>;
  previousRecords?: PatientRecordWithDeviceData<PatientRecord>[];
}

type NightscoutProfileOptions = {
  nightscoutProfileName?: string;
  nightscoutProfileLoader?: () => Promise<Profile>;
  nightscoutProfileHandler?: (profile: Profile) => Promise<Profile>;
};

export function identifyTreatments(
  records: PatientRecordWithDeviceData<PatientRecord>[]
) {
  const unprocessedRecords: PatientRecordWithDeviceData<
    CarbRecord | BolusRecord
  >[] = [];
  const treatments = records
    .filter<PatientRecordWithDeviceData<CarbRecord | BolusRecord>>(
      (
        record
      ): record is PatientRecordWithDeviceData<CarbRecord | BolusRecord> =>
        ["insulin_bolus", "carb"].includes(record.type)
    )
    .reduce<
      (
        | MealBolusTreatment
        | CorrectionBolusTreatment
        | CarbCorrectionTreatment
      )[]
    >((treatments, record, _index, allRecords) => {
      try {
        const treatment = diasendRecordToNightscoutTreatment(
          record,
          allRecords
        );

        if (treatment) {
          treatments.push(treatment);
        }
      } catch (e) {
        // if an error happened, this means, we'll need to remember the record and try to resolve it in the next run
        unprocessedRecords.push(record);
      }

      return treatments;
    }, []);

  return { treatments, unprocessedRecords };
}

async function syncDiasendGlucoseToNightscout({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  diasendClientId = config.diasend.clientId,
  diasendClientSecret = config.diasend.clientSecret,
  nightscoutEntriesHandler = (entries) => reportEntriesToNightscout(entries),
  dateFrom = dayjs().subtract(10, "minutes").toDate(),
  dateTo = new Date(),
}: SyncDiasendGlucoseToNightscoutArgs) {
  const records = await getDiasendPatientData({
    diasendUsername,
    diasendPassword,
    diasendClientId,
    diasendClientSecret,
    dateFrom,
    dateTo,
  });

  // we only care about glucose values, ignore everything else
  const nightscoutEntries: Entry[] = records
    // TODO: support non-glucose type values
    // TODO: treat calibration events differently?
    .filter<PatientRecordWithDeviceData<GlucoseRecord>>(
      (record): record is PatientRecordWithDeviceData<GlucoseRecord> =>
        record.type === "glucose"
    )
    .map<Entry>((record) => diasendGlucoseRecordToNightscoutEntry(record));

  console.log(
    `Number of glucose records since ${dayjs(dateFrom).from(
      dateTo
    )} (${dateFrom.toISOString()} - ${dateTo.toISOString()}): `,
    nightscoutEntries.length
  );

  // send them to nightscout
  console.log(`Sending ${nightscoutEntries.length} entries to nightscout`);
  const entries = await nightscoutEntriesHandler(nightscoutEntries);
  return {
    entries,
    latestRecordDate:
      entries.length > 0
        ? new Date(
            // get latest record's date
            entries.sort((a, b) => dayjs(b.date).diff(a.date))[0].date
          )
        : null,
  };
}

async function syncDiasendDataToNightscout({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  diasendClientId = config.diasend.clientId,
  diasendClientSecret = config.diasend.clientSecret,
  nightscoutTreatmentsHandler = (treatments) =>
    reportTreatmentsToNightscout(treatments),
  nightscoutProfileName = config.nightscout.profileName!,
  nightscoutProfileHandler = (profile) => updateProfile(profile),
  nightscoutProfileLoader = () => fetchProfile(),
  dateFrom = dayjs().subtract(10, "minutes").toDate(),
  dateTo = new Date(),
  previousRecords = [],
}: SyncDiasendDataToNightScoutArgs & NightscoutProfileOptions) {
  const records = (
    await getDiasendPatientData({
      diasendUsername,
      diasendPassword,
      diasendClientId,
      diasendClientSecret,
      dateFrom,
      dateTo,
    })
  )
    // filter out glucose records as they're handled independently
    .filter((r) => r.type !== "glucose");

  // calculate the latest record date
  // this has to be done before re-adding the previously postponed records
  const latestRecordDate =
    records.length > 0
      ? new Date(
          records
            // sort records by date (descending)
            .sort((r1, r2) =>
              dayjs(r2.created_at).diff(r1.created_at)
            )[0].created_at
        )
      : null;

  // include any unprocessed records from previous runs
  records.unshift(...previousRecords);

  // handle insulin boli and carbs
  const { treatments: nightscoutTreatments, unprocessedRecords } =
    identifyTreatments(records);

  // handle basal rates
  const existingProfile = await nightscoutProfileLoader();
  const existingProfileConfig: ProfileConfig =
    nightscoutProfileName in existingProfile.store
      ? existingProfile.store[nightscoutProfileName]
      : existingProfile.store[existingProfile.defaultProfile];
  const basalRecords = records.filter<PatientRecordWithDeviceData<BasalRecord>>(
    (record): record is PatientRecordWithDeviceData<BasalRecord> =>
      record.type === "insulin_basal"
  );
  const updatedBasalProfile = updateBasalProfile(
    existingProfileConfig.basal || [],
    basalRecords
  );
  const updatedProfile: Profile = {
    ...existingProfile,
    store: {
      ...existingProfile.store,
      [nightscoutProfileName]: {
        ...existingProfileConfig,
        basal: updatedBasalProfile,
      },
    },
  };

  console.log(
    `Sending ${nightscoutTreatments.length} treatments to nightscout`
  );
  console.log(`Updating basal profile based on ${basalRecords.length} records`);
  // send them to nightscout
  const [treatments, profile] = await Promise.all([
    nightscoutTreatmentsHandler(nightscoutTreatments),
    nightscoutProfileHandler(updatedProfile),
  ]);

  return {
    treatments: treatments ?? [],
    profile,
    latestRecordDate,
    unprocessedRecords: unprocessedRecords
      // prevent any of the records that were unprocessed previously to be again in the list of unprocessed records
      .filter((record) => previousRecords.indexOf(record) === -1),
  };
}

// CamAPSFx uploads data to diasend every 5 minutes. (Which is also the time after which new CGM values from Dexcom will be available)
const interval = 5 * 60 * 1000;

async function getDiasendPatientData({
  diasendUsername,
  diasendPassword,
  diasendClientId,
  diasendClientSecret,
  dateFrom,
  dateTo,
}: {
  diasendUsername: string | undefined;
  diasendPassword: string | undefined;
  diasendClientId: string;
  diasendClientSecret: string;
  dateFrom: Date;
  dateTo: Date;
}) {
  if (!diasendUsername) {
    throw Error("Diasend Username not configured");
  }
  if (!diasendPassword) {
    throw Error("Diasend Password not configured");
  }

  const { access_token: diasendAccessToken } = await obtainDiasendAccessToken(
    diasendClientId,
    diasendClientSecret,
    diasendUsername,
    diasendPassword
  );

  // using the diasend token, now fetch the patient records per device
  const records = await getPatientData(diasendAccessToken, dateFrom, dateTo);
  return records.flatMap((record) =>
    record.data.map<PatientRecordWithDeviceData<PatientRecord>>((r) => ({
      ...r,
      device: record.device,
    }))
  );
}

export function startSynchronization({
  pollingIntervalMs = interval,
  dateFrom = dayjs().subtract(interval, "milliseconds").toDate(),
  ...syncArgs
}: {
  pollingIntervalMs?: number;
} & SyncDiasendDataToNightScoutArgs &
  SyncDiasendGlucoseToNightscoutArgs &
  NightscoutProfileOptions = {}) {
  const entriesLoop = new Looper<SyncDiasendGlucoseToNightscoutArgs>(
    pollingIntervalMs,
    async ({ dateTo, ...args } = {}) => {
      const { latestRecordDate } = await syncDiasendGlucoseToNightscout({
        dateTo,
        ...args,
      });
      // remove the dateTo option
      return {
        ...args,
        dateFrom: latestRecordDate
          ? dayjs(latestRecordDate).add(1, "second").toDate()
          : args.dateFrom,
      };
    },
    "Entries"
  ).loop({ dateFrom, ...syncArgs });

  const treatmentsLoop = new Looper<
    SyncDiasendDataToNightScoutArgs & NightscoutProfileOptions
  >(
    pollingIntervalMs,
    async ({ dateTo, ...args } = {}) => {
      const { latestRecordDate, unprocessedRecords } =
        await syncDiasendDataToNightscout({
          dateTo,
          ...args,
        });
      // next run's data should be fetched where this run ended, so take a look at the records
      console.log(
        `Scheduling ${unprocessedRecords.length} records for processing in next run`
      );
      // remove the dateTo option
      return {
        ...args,
        dateFrom: latestRecordDate
          ? dayjs(latestRecordDate).add(1, "second").toDate()
          : args.dateFrom,
        previousRecords: unprocessedRecords,
      };
    },
    "Treatments"
  ).loop({ dateFrom, ...syncArgs });

  // return a function that can be used to end the loop
  return () => {
    entriesLoop.stop();
    treatmentsLoop.stop();
  };
}

export function startPumpSettingsSynchronization({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  // per default synchronize every 12 hours
  pollingIntervalMs = 12 * 3600 * 1000,
  nightscoutProfileName = config.nightscout.profileName,
  nightscoutProfileLoader = async () => await fetchProfile(),
  nightscoutProfileHandler = async (profile: Profile) =>
    await updateProfile(profile),
  importBasalRate = true,
}: {
  diasendUsername?: string;
  diasendPassword?: string;
  pollingIntervalMs?: number;
  importBasalRate?: boolean;
} & NightscoutProfileOptions = {}) {
  if (!diasendUsername) {
    throw Error("Diasend Username not configured");
  }
  if (!diasendPassword) {
    throw Error("Diasend Password not configured");
  }

  if (!nightscoutProfileName) {
    console.info(
      "Not synchronizing pump settings to nightscout profile since profile name is not defined"
    );
    return;
  }

  const looper = new Looper(
    pollingIntervalMs,
    async () => {
      const { client, userId } = await getAuthenticatedScrapingClient({
        username: diasendUsername,
        password: diasendPassword,
      });
      const pumpSettings = await getPumpSettings(client, userId);
      const updatedNightscoutProfile = updateNightScoutProfileWithPumpSettings(
        await nightscoutProfileLoader(),
        pumpSettings,
        { importBasalRate, nightscoutProfileName }
      );
      await nightscoutProfileHandler(updatedNightscoutProfile);
    },
    "Pump Settings"
  ).loop();

  // return a function that can be used to end the loop
  return () => {
    looper.stop();
  };
}
