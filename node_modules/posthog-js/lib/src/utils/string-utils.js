"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripLeadingDollar = exports.trim = void 0;
exports.includes = includes;
exports.isDistinctIdStringLike = isDistinctIdStringLike;
function includes(str, needle) {
    return str.indexOf(needle) !== -1;
}
var trim = function (str) {
    // Previous implementation was using underscore's trim function.
    // When switching to just using the native trim() function, we ran some tests to make sure that it was able to trim both the BOM character \uFEFF and the NBSP character \u00A0.
    // We tested modern Chrome (134.0.6998.118) and Firefox (136.0.2), and IE11 running on Windows 10, and all of them were able to trim both characters.
    // See https://posthog.slack.com/archives/C0113360FFV/p1742811455647359
    return str.trim();
};
exports.trim = trim;
// UNDERSCORE
// Embed part of the Underscore Library
var stripLeadingDollar = function (s) {
    return s.replace(/^\$/, '');
};
exports.stripLeadingDollar = stripLeadingDollar;
function isDistinctIdStringLike(value) {
    return ['distinct_id', 'distinctid'].includes(value.toLowerCase());
}
//# sourceMappingURL=string-utils.js.map