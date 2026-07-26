// Child-process fixture: any unexpected network path fails deterministically.
globalThis.fetch = async () => {
  throw new Error("offline subprocess fixture forbids fetch");
};
