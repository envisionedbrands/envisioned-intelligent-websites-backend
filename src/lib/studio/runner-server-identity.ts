function normalizeOrigin(raw: string, label: string) {
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
}

export function configuredStudioDatabaseOrigin() {
  const publicRaw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serverRaw = process.env.SUPABASE_URL;
  const publicOrigin = publicRaw ? normalizeOrigin(publicRaw, 'NEXT_PUBLIC_SUPABASE_URL') : null;
  const serverOrigin = serverRaw ? normalizeOrigin(serverRaw, 'SUPABASE_URL') : null;
  if (publicOrigin && serverOrigin && publicOrigin !== serverOrigin) {
    throw new Error('The backend Supabase URLs point to different projects.');
  }
  const origin = publicOrigin || serverOrigin;
  if (!origin) throw new Error('The backend database identity is not configured.');
  return origin;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function studioRunnerInstanceId(backendUrl: string, databaseUrl: string) {
  const backendOrigin = normalizeOrigin(backendUrl, 'Backend URL');
  const databaseOrigin = normalizeOrigin(databaseUrl, 'Supabase URL');
  return (await sha256(`${backendOrigin}\n${databaseOrigin}`)).slice(0, 12);
}

export async function expectedStudioRunnerInstanceId(requestUrl: string) {
  return studioRunnerInstanceId(requestUrl, configuredStudioDatabaseOrigin());
}

export async function studioDatabaseOriginFingerprint(databaseUrl: string) {
  return sha256(normalizeOrigin(databaseUrl, 'Supabase URL'));
}
