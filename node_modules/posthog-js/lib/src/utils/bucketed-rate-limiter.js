"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BucketedRateLimiter = void 0;
var number_utils_1 = require("./number-utils");
var BucketedRateLimiter = /** @class */ (function () {
    function BucketedRateLimiter(_options) {
        var _this = this;
        this._options = _options;
        this._buckets = {};
        this._refillBuckets = function () {
            Object.keys(_this._buckets).forEach(function (key) {
                var newTokens = _this._getBucket(key) + _this._refillRate;
                if (newTokens >= _this._bucketSize) {
                    delete _this._buckets[key];
                }
                else {
                    _this._setBucket(key, newTokens);
                }
            });
        };
        this._getBucket = function (key) {
            return _this._buckets[String(key)];
        };
        this._setBucket = function (key, value) {
            _this._buckets[String(key)] = value;
        };
        this.consumeRateLimit = function (key) {
            var _a, _b;
            var tokens = (_a = _this._getBucket(key)) !== null && _a !== void 0 ? _a : _this._bucketSize;
            tokens = Math.max(tokens - 1, 0);
            if (tokens === 0) {
                return true;
            }
            _this._setBucket(key, tokens);
            var hasReachedZero = tokens === 0;
            if (hasReachedZero) {
                (_b = _this._onBucketRateLimited) === null || _b === void 0 ? void 0 : _b.call(_this, key);
            }
            return hasReachedZero;
        };
        this._onBucketRateLimited = this._options._onBucketRateLimited;
        this._bucketSize = (0, number_utils_1.clampToRange)(this._options.bucketSize, 0, 100, 'rate limiter bucket size');
        this._refillRate = (0, number_utils_1.clampToRange)(this._options.refillRate, 0, this._bucketSize, // never refill more than bucket size
        'rate limiter refill rate');
        this._refillInterval = (0, number_utils_1.clampToRange)(this._options.refillInterval, 0, 86400000, // one day in milliseconds
        'rate limiter refill interval');
        setInterval(function () {
            _this._refillBuckets();
        }, this._refillInterval);
    }
    return BucketedRateLimiter;
}());
exports.BucketedRateLimiter = BucketedRateLimiter;
//# sourceMappingURL=bucketed-rate-limiter.js.map