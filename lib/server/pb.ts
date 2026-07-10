import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";

const globalForPB = globalThis as unknown as { __serverPB?: PocketBase };

export function getServerPB(): PocketBase {
  if (!globalForPB.__serverPB) {
    globalForPB.__serverPB = new PocketBase(PB_URL);
    globalForPB.__serverPB.autoCancellation(false);
  }
  return globalForPB.__serverPB;
}
