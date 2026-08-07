const MAX_TEXT_LENGTH = 50000;
const MAX_INSTRUCTION_LENGTH = 2000;

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isNonEmptyString(val, maxLength = MAX_TEXT_LENGTH) {
  return typeof val === "string" && val.trim().length > 0 && val.length <= maxLength;
}

module.exports = { isValidUrl, isNonEmptyString, MAX_TEXT_LENGTH, MAX_INSTRUCTION_LENGTH };
