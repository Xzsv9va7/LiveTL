const YTCFG_KEYS = [
  'INNERTUBE_API_KEY',
  'INNERTUBE_CONTEXT',
  'SESSION_INDEX',
  'VISITOR_DATA',
  'INNERTUBE_CLIENT_NAME',
  'INNERTUBE_CONTEXT_CLIENT_NAME',
  'INNERTUBE_CLIENT_VERSION',
  'INNERTUBE_CONTEXT_CLIENT_VERSION',
  'DELEGATED_SESSION_ID',
  'ID_TOKEN',
];

const cloneOwn = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneOwn(item, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    try {
      out[key] = cloneOwn((value as Record<string, unknown>)[key], seen);
    } catch {}
  }
  return out;
};

const snapshotYtcfg = (): { data_: Record<string, unknown> } => {
  const ytcfg = (window as any).ytcfg;
  const data_: Record<string, unknown> = {};
  const raw = ytcfg?.data_;
  if (raw != null && typeof raw === 'object') {
    for (const key of Object.getOwnPropertyNames(raw)) {
      try {
        data_[key] = raw[key];
      } catch {}
    }
  }
  if (typeof ytcfg?.get === 'function') {
    for (const key of YTCFG_KEYS) {
      try {
        const value = ytcfg.get(key);
        if (value != null) data_[key] = value;
      } catch {}
    }
  }
  if (data_.INNERTUBE_CONTEXT != null) {
    data_.INNERTUBE_CONTEXT = cloneOwn(data_.INNERTUBE_CONTEXT);
  }
  return { data_ };
};

const emit = (force = false): boolean => {
  const snapshot = snapshotYtcfg();
  if (!force && snapshot.data_.INNERTUBE_CONTEXT == null) return false;
  window.dispatchEvent(
    new CustomEvent('fetchMeta', {
      detail: JSON.stringify(snapshot),
    }),
  );
  return true;
};

if (!emit()) {
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (emit() || attempts >= 20) {
      window.clearInterval(timer);
      if (attempts >= 20) emit(true);
    }
  }, 100);
}

export {};
