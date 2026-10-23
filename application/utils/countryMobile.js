// Country → dial code + local mobile length, mirroring the Odoo module's
// COUNTRY_MOBILE_LENGTH (see res_company_kpi.py). Used by the country picker on
// phone-number inputs so India → +91 / 10 digits, Oman → +968 / 8 digits, etc.
//
// { code (ISO2), name, dial (digits, no +), length (local digit count) }

export const COUNTRIES = [
  { code: 'IN', name: 'India', dial: '91', length: 10 },
  { code: 'OM', name: 'Oman', dial: '968', length: 8 },
  { code: 'AE', name: 'United Arab Emirates', dial: '971', length: 9 },
  { code: 'SA', name: 'Saudi Arabia', dial: '966', length: 9 },
  { code: 'QA', name: 'Qatar', dial: '974', length: 8 },
  { code: 'KW', name: 'Kuwait', dial: '965', length: 8 },
  { code: 'BH', name: 'Bahrain', dial: '973', length: 8 },
  { code: 'JO', name: 'Jordan', dial: '962', length: 9 },
  { code: 'US', name: 'United States', dial: '1', length: 10 },
  { code: 'CA', name: 'Canada', dial: '1', length: 10 },
  { code: 'GB', name: 'United Kingdom', dial: '44', length: 10 },
  { code: 'IE', name: 'Ireland', dial: '353', length: 9 },
  { code: 'AU', name: 'Australia', dial: '61', length: 9 },
  { code: 'NZ', name: 'New Zealand', dial: '64', length: 9 },
  { code: 'DE', name: 'Germany', dial: '49', length: 10 },
  { code: 'FR', name: 'France', dial: '33', length: 9 },
  { code: 'IT', name: 'Italy', dial: '39', length: 10 },
  { code: 'ES', name: 'Spain', dial: '34', length: 9 },
  { code: 'NL', name: 'Netherlands', dial: '31', length: 9 },
  { code: 'BE', name: 'Belgium', dial: '32', length: 9 },
  { code: 'CH', name: 'Switzerland', dial: '41', length: 9 },
  { code: 'SE', name: 'Sweden', dial: '46', length: 9 },
  { code: 'NO', name: 'Norway', dial: '47', length: 8 },
  { code: 'DK', name: 'Denmark', dial: '45', length: 8 },
  { code: 'FI', name: 'Finland', dial: '358', length: 9 },
  { code: 'PT', name: 'Portugal', dial: '351', length: 9 },
  { code: 'AT', name: 'Austria', dial: '43', length: 10 },
  { code: 'PL', name: 'Poland', dial: '48', length: 9 },
  { code: 'SG', name: 'Singapore', dial: '65', length: 8 },
  { code: 'MY', name: 'Malaysia', dial: '60', length: 9 },
  { code: 'ID', name: 'Indonesia', dial: '62', length: 10 },
  { code: 'PH', name: 'Philippines', dial: '63', length: 10 },
  { code: 'TH', name: 'Thailand', dial: '66', length: 9 },
  { code: 'VN', name: 'Vietnam', dial: '84', length: 9 },
  { code: 'KR', name: 'South Korea', dial: '82', length: 10 },
  { code: 'JP', name: 'Japan', dial: '81', length: 10 },
  { code: 'CN', name: 'China', dial: '86', length: 11 },
  { code: 'HK', name: 'Hong Kong', dial: '852', length: 8 },
  { code: 'TW', name: 'Taiwan', dial: '886', length: 9 },
  { code: 'PK', name: 'Pakistan', dial: '92', length: 10 },
  { code: 'BD', name: 'Bangladesh', dial: '880', length: 10 },
  { code: 'LK', name: 'Sri Lanka', dial: '94', length: 9 },
  { code: 'NP', name: 'Nepal', dial: '977', length: 10 },
  { code: 'ZA', name: 'South Africa', dial: '27', length: 9 },
  { code: 'NG', name: 'Nigeria', dial: '234', length: 10 },
  { code: 'KE', name: 'Kenya', dial: '254', length: 9 },
  { code: 'EG', name: 'Egypt', dial: '20', length: 10 },
  { code: 'TR', name: 'Turkey', dial: '90', length: 10 },
  { code: 'RU', name: 'Russia', dial: '7', length: 10 },
  { code: 'BR', name: 'Brazil', dial: '55', length: 11 },
  { code: 'MX', name: 'Mexico', dial: '52', length: 10 },
];

// Default (matches the web module default).
export const DEFAULT_COUNTRY = COUNTRIES[0]; // India

export function findCountry(code) {
  return COUNTRIES.find((c) => c.code === code) || DEFAULT_COUNTRY;
}

// Keep only digits, cap to the country's local length, and strip a pasted dial
// code if the user pasted a full international number.
export function toLocalDigits(value, country) {
  let d = String(value || '').replace(/[^\d]/g, '');
  const { dial, length } = country || DEFAULT_COUNTRY;
  if (dial && d.length > length && d.startsWith(dial)) d = d.slice(dial.length);
  return d.slice(0, length);
}

// Full number as bare <dial><local> digits (what the backend stores).
export function toFullNumber(localDigits, country) {
  const c = country || DEFAULT_COUNTRY;
  const d = String(localDigits || '').replace(/[^\d]/g, '').slice(0, c.length);
  return d ? c.dial + d : '';
}
