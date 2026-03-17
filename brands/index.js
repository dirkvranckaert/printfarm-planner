'use strict';

// Printer brand registry.
//
// Each brand module in this directory must export:
//
//   id:   string          — slug used in DB (printer.brand) and API paths
//   name: string          — display name
//
//   connect(db)           — async, called once on server start
//   disconnect()          — stop live connection
//   reinit(db)            — async, disconnect then reconnect (after config change)
//   isConnected()         — boolean
//
//   getPrinterKey(printer)          — returns the status-map key for a printer DB row,
//                                     or null if this printer is not configured for live updates
//   subscribeForPrinter(printer)    — subscribe a newly added/updated printer to live updates
//   getStatus(printerKey)           — statusObj | null
//   getAllStatuses()                 — { [printerKey]: statusObj }
//   onUpdate(cb)                    — register cb(printerKey, statusObj) callback
//
//   router  (optional)  — Express Router mounted at /api/brands/{id}/
//
// Status object shape (all fields optional except updated_at):
//   {
//     stage:         'RUNNING' | 'PAUSE' | 'FINISH' | 'FAILED' | 'IDLE'
//     progress:      number   (0–100)
//     remaining:     number   (minutes)
//     nozzle_temp:   number
//     nozzle_target: number
//     bed_temp:      number
//     bed_target:    number
//     slots: [{              // multi-color / filament info
//       id:        string    // e.g. 'A1', 'A2', 'Ext'
//       label:     string
//       color:     string | null   // CSS hex e.g. '#FF69B4'
//       material:  string | null
//       remainPct: number | null
//       k:         number | null
//       active:    boolean
//       empty:     boolean
//     }]
//     updated_at: string     // ISO 8601
//   }
//
// SSE / status keys are namespaced as "{brand.id}:{printerKey}"
// e.g. "bambulab:01P00A123456789"
//
// To add a new brand: create brands/{slug}.js and add it to the registry array below.

const bambulab = require('./bambulab');

const registry = [
  bambulab,
  // Add future brands here, e.g.:
  // require('./prusa'),
  // require('./klipper'),
];

module.exports = {
  /** All registered brand modules */
  all: registry,

  /** Look up a brand by id slug */
  get(id) {
    return registry.find(b => b.id === id) || null;
  },

  /** Connect all brands (called once on server start) */
  async connectAll(db) {
    for (const brand of registry) {
      await brand.connect(db).catch(err =>
        console.error(`[brands/${brand.id}] connect error:`, err.message)
      );
    }
  },

  /**
   * Register an update callback across all brands.
   * The callback receives (brandKey, statusObj) where
   * brandKey = "{brand.id}:{printerKey}" e.g. "bambulab:01P00A123456789".
   */
  onUpdate(cb) {
    for (const brand of registry) {
      brand.onUpdate((printerKey, status) => cb(`${brand.id}:${printerKey}`, status));
    }
  },

  /**
   * Merged status snapshot from all brands.
   * Keys are namespaced: "bambulab:01P00A123456789"
   */
  getAllStatuses() {
    const out = {};
    for (const brand of registry) {
      const statuses = brand.getAllStatuses();
      for (const [key, status] of Object.entries(statuses)) {
        out[`${brand.id}:${key}`] = status;
      }
    }
    return out;
  },

  /**
   * Subscribe a printer to its brand's live updates.
   * Call after adding or updating a printer.
   */
  subscribeForPrinter(printer) {
    const brand = registry.find(b => b.id === printer.brand);
    if (brand) brand.subscribeForPrinter(printer);
  },
};
