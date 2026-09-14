import i18n from "@/client/i18n";

// Component tests render the admin UI in the default English language. The
// browser-language auto-detection in src/client/i18n.ts can pick up a Chinese
// system locale in CI; pin the test environment to English so existing
// structure/label assertions stay deterministic.
void i18n.changeLanguage("en");
