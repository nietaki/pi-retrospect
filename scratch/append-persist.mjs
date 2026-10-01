import { SessionManager } from "@earendil-works/pi-coding-agent";
const p = "/tmp/appends.jsonl";
const m = SessionManager.open(p);
console.log("version before:", m.getHeader().version, "| entries:", m.getEntryCount(), "| persisted:", m.isPersisted());
