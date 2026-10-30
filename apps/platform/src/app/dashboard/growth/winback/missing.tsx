import Link from "next/link";
import { MISSING_FIX, MISSING_MESSAGE, type Missing } from "@/lib/winback/readiness";

/**
 * Why nothing can be sent yet, and — when it is something the client fills
 * in themselves — a link straight to that field of their profile, so they
 * do not have to go looking for where the address goes.
 */
export function MissingReason({ missing }: { missing: Missing }) {
  const fix = MISSING_FIX[missing];
  return (
    <>
      {MISSING_MESSAGE[missing]}
      {fix && (
        <>
          {" "}
          <Link href={fix.href} className="winback-fix">
            {fix.label}
          </Link>
        </>
      )}
    </>
  );
}
