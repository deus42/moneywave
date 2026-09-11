const HTTPS_EGRESS_HOSTS = new Set([
  "acp.privatbank.ua",
  "api.monobank.ua",
  "api.privatbank.ua",
  "api.wise.com",
  "bank.gov.ua",
  "data-api.ecb.europa.eu",
]);

export function assertAllowedEgress(input: string | URL): URL {
  const url = input instanceof URL ? input : new URL(input);
  if (!HTTPS_EGRESS_HOSTS.has(url.hostname)) throw new Error("EGRESS_HOST_DENIED");
  if (url.protocol !== "https:") throw new Error("EGRESS_TLS_REQUIRED");
  return url;
}

export async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = assertAllowedEgress(input);
  return fetch(url, { ...init, redirect: "error" });
}
