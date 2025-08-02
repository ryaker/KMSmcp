"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampToRange = clampToRange;
var type_utils_1 = require("./type-utils");
var logger_1 = require("./logger");
/**
 * Clamps a value to a range.
 * @param value the value to clamp
 * @param min the minimum value
 * @param max the maximum value
 * @param label if provided then enables logging and prefixes all logs with labels
 * @param fallbackValue if provided then returns this value if the value is not a valid number
 */
function clampToRange(value, min, max, label, fallbackValue) {
    if (min > max) {
        logger_1.logger.warn('min cannot be greater than max.');
        min = max;
    }
    if (!(0, type_utils_1.isNumber)(value)) {
        label &&
            logger_1.logger.warn(label + ' must be a number. using max or fallback. max: ' + max + ', fallback: ' + fallbackValue);
        return clampToRange(fallbackValue || max, min, max, label);
    }
    else if (value > max) {
        label && logger_1.logger.warn(label + ' cannot be  greater than max: ' + max + '. Using max value instead.');
        return max;
    }
    else if (value < min) {
        label && logger_1.logger.warn(label + ' cannot be less than min: ' + min + '. Using min value instead.');
        return min;
    }
    else {
        return value;
    }
}
//# sourceMappingURL=number-utils.js.map