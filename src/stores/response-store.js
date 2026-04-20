const MAX_ENTRIES = 1000;

const store = new Map();

function storeResponse(id, data) {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(id, { ...data, createdAt: Date.now() });
}

function getResponse(id) {
  return store.get(id) || null;
}

function deleteResponse(id) {
  return store.delete(id);
}

function size() {
  return store.size;
}

module.exports = { storeResponse, getResponse, deleteResponse, size };
