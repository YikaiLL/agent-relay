// Revision-keyed cache for the dedicated Devices channel.
export function createDevicesCache() {
  let syncedRevision = null;
  let inflightRevision = null;
  let loaded = false;
  let data = {
    device_records: [],
    paired_devices: [],
    pending_pairing_requests: [],
  };

  return {
    current() {
      return data;
    },
    hasData() {
      return loaded;
    },
    async sync(snapshotRevision, fetchDevices, onUpdate) {
      if (snapshotRevision == null) return;
      if (syncedRevision === snapshotRevision || inflightRevision === snapshotRevision) return;
      inflightRevision = snapshotRevision;
      try {
        const response = await fetchDevices();
        if (inflightRevision !== snapshotRevision || response == null) return;
        syncedRevision = snapshotRevision;
        loaded = true;
        data = {
          device_records: response.device_records || [],
          paired_devices: response.paired_devices || [],
          pending_pairing_requests: response.pending_pairing_requests || [],
        };
        onUpdate?.();
      } catch (_error) {
        // Keep stale device state and retry on the next render of this revision.
      } finally {
        if (inflightRevision === snapshotRevision) inflightRevision = null;
      }
    },
  };
}
