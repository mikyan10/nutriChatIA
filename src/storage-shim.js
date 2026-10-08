// Implementa window.storage (API async del entorno de artifacts) sobre localStorage.
const P = "nutrichat:";
window.storage = {
  async get(key) {
    const v = localStorage.getItem(P + key);
    return v === null ? null : { key, value: v, shared: false };
  },
  async set(key, value) {
    localStorage.setItem(P + key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    localStorage.removeItem(P + key);
    return { key, deleted: true, shared: false };
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(P + prefix)) keys.push(k.slice(P.length));
    }
    return { keys, prefix, shared: false };
  }
};
