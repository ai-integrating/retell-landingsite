// Loaded before tests. No real HTTP/TCP/DNS/fetch calls are allowed.
const blocked = () => { throw new Error("TEST_NETWORK_BLOCKED"); };
for (const name of ["http", "https"]) {
  const module = require(`node:${name}`);
  module.request = blocked;
  module.get = blocked;
}
require("node:net").Socket.prototype.connect = blocked;
require("node:tls").connect = blocked;
require("node:dns").lookup = blocked;
globalThis.fetch = blocked;
require("node:module").syncBuiltinESMExports();
