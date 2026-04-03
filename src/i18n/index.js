import { translations } from "./translations.js";
import { SERVER_ERROR_TO_I18N_KEY } from "./serverErrorMap.js";

const BCP47 = { uz: "uz-UZ", ru: "ru-RU", en: "en-US" };

export const LOCALE_STORAGE_KEY = "keldi-locale";

export function localeToBcp47(locale) {
  return BCP47[locale] || BCP47.uz;
}

function getNested(obj, path) {
  return path.split(".").reduce((o, k) => (o != null && typeof o === "object" ? o[k] : undefined), obj);
}

export function translateApiError(message, locale) {
  const msg = String(message ?? "").trim();
  if (!msg) return "";
  const key = SERVER_ERROR_TO_I18N_KEY[msg];
  if (key) return translate(locale, key);
  return msg;
}

export function translate(locale, key, vars) {
  const loc = locale === "ru" || locale === "en" ? locale : "uz";
  let str = getNested(translations[loc], key);
  if (typeof str !== "string") str = getNested(translations.uz, key);
  if (typeof str !== "string") return key;
  if (vars && typeof vars === "object") {
    return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
  }
  return str;
}
