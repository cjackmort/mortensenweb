/**
 * The DNS records a client has to create to point their domain at us.
 *
 * Netlify's own guidance is "use our nameservers", which is the easiest route
 * for us and often the wrong one for the client: moving nameservers moves
 * *everything*, including their email. A small business whose MX records live
 * with their domain registrar can lose email for a day by following that
 * advice, and they will not connect the two events.
 *
 * So the default here is the conservative one — an A record for the apex and a
 * CNAME for `www`, leaving every other record where it is. Slower to propagate,
 * marginally worse at failover, and it cannot take down somebody's email.
 */

export interface DnsRecord {
  type: "A" | "CNAME" | "ALIAS";
  /** What goes in the registrar's "host" or "name" field. */
  host: string;
  value: string;
  /** Explains the record in terms a non-technical reader can act on. */
  note: string;
}

/**
 * Netlify's load balancer address.
 *
 * Documented as stable and safe to hardcode; overridable because a documented
 * constant that changes with no way to update it is a support incident.
 */
export function netlifyLoadBalancerIp(): string {
  return process.env.NETLIFY_LOAD_BALANCER_IP ?? "75.2.60.5";
}

/** Strip a pasted URL down to a bare hostname, dropping any `www.`. */
export function apexDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const host = trimmed
    .replace(/^https?:\/\//, "")
    .split("/")[0]!
    .replace(/^www\./, "")
    .trim();

  if (!host.includes(".") || /\s/.test(host)) return null;
  return host;
}

/**
 * Build the record set for one domain.
 *
 * `netlifySiteName` is the target of the `www` CNAME. It has to be the real
 * site name rather than the custom domain, because at the point these
 * instructions are sent the custom domain does not resolve yet — that is the
 * entire purpose of the exercise.
 */
export function buildDnsRecords(
  domain: string,
  netlifySiteName: string,
): DnsRecord[] {
  const apex = apexDomain(domain);
  if (!apex) return [];

  return [
    {
      type: "A",
      host: "@",
      value: netlifyLoadBalancerIp(),
      note: `Points ${apex} at your new site. "@" means the domain on its own, with no www.`,
    },
    {
      type: "CNAME",
      host: "www",
      value: `${netlifySiteName}.netlify.app`,
      note: `Points www.${apex} at the same place, so both addresses work.`,
    },
  ];
}

/**
 * Render the records as a plain-text table.
 *
 * Monospace and aligned because the reader is copying values into a registrar's
 * form field, one at a time, and a wrapped or reflowed value is how a trailing
 * space ends up in an A record.
 */
export function renderRecordsText(records: DnsRecord[]): string {
  const rows = records.map((record) => ({
    type: record.type,
    host: record.host,
    value: record.value,
  }));

  const width = (key: "type" | "host" | "value", header: string) =>
    Math.max(header.length, ...rows.map((row) => row[key].length));

  const w = {
    type: width("type", "Type"),
    host: width("host", "Host"),
    value: width("value", "Value"),
  };

  const line = (type: string, host: string, value: string) =>
    `${type.padEnd(w.type)}  ${host.padEnd(w.host)}  ${value}`;

  return [
    line("Type", "Host", "Value"),
    line("-".repeat(w.type), "-".repeat(w.host), "-".repeat(w.value)),
    ...rows.map((row) => line(row.type, row.host, row.value)),
  ].join("\n");
}
