'use strict'
module.exports = {
  migrate: (data, fromVersion) => ({ ...data, schema: 1, migratedFrom: fromVersion || null }),
  execute: async (_id, input, host) => host.request('life.virtual-project', input)
}
