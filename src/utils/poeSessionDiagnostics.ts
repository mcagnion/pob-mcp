export function formatPoeSessionIdDiagnostic(sessionId = process.env.POE_SESSION_ID): string {
  if (!sessionId) {
    return 'POE_SESSION_ID configured: no';
  }

  return `POE_SESSION_ID configured: yes (length=${sessionId.length}, fingerprint=${fingerprintPoeSessionId(sessionId)})`;
}

function fingerprintPoeSessionId(sessionId: string): string {
  if (sessionId.length <= 8) {
    return `short:${sessionId.length}`;
  }

  return `${sessionId.slice(0, 4)}...${sessionId.slice(-4)}`;
}
