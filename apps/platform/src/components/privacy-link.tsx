import "./privacy-link.css";

/**
 * One privacy policy covers the portal and mortensenweb.com, and it lives on
 * the public site because that URL is the one Google's OAuth consent screen
 * names. A plain anchor: it leaves the portal, so next/link has nothing to do.
 */
export const PRIVACY_POLICY_URL = "https://mortensenweb.com/privacy/";

export function PrivacyFooter() {
  return (
    <footer className="privacy-footer">
      <a href={PRIVACY_POLICY_URL}>Privacy policy</a>
    </footer>
  );
}
