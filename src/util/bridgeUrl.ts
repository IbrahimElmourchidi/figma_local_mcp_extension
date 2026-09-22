export interface HostPort {
  readonly host: string;
  readonly port: number;
}

/** Bracket IPv6 literals so `::1` becomes `http://[::1]:3845`, not `http://::1:3845`. */
export function bridgeUrl({ host, port }: HostPort): string {
  const formattedHost = formatHost(host);
  return `http://${formattedHost}:${port}`;
}

export function formatHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}
