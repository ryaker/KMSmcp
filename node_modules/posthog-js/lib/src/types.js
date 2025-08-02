"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.severityLevels = exports.Compression = exports.knownUnsafeEditableEvent = exports.COPY_AUTOCAPTURE_EVENT = void 0;
exports.COPY_AUTOCAPTURE_EVENT = '$copy_autocapture';
exports.knownUnsafeEditableEvent = [
    '$snapshot',
    '$pageview',
    '$pageleave',
    '$set',
    'survey dismissed',
    'survey sent',
    'survey shown',
    '$identify',
    '$groupidentify',
    '$create_alias',
    '$$client_ingestion_warning',
    '$web_experiment_applied',
    '$feature_enrollment_update',
    '$feature_flag_called',
];
var Compression;
(function (Compression) {
    Compression["GZipJS"] = "gzip-js";
    Compression["Base64"] = "base64";
})(Compression || (exports.Compression = Compression = {}));
// levels originally copied from Sentry to work with the sentry integration
// and to avoid relying on a frequently changing @sentry/types dependency
// but provided as an array of literal types, so we can constrain the level below
exports.severityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug'];
//# sourceMappingURL=types.js.map