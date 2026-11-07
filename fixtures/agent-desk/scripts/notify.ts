export async function notifyOnCall(summary: string) {
  const hook = process.env.ONCALL_HOOK as string;
  await fetch(hook, { method: 'POST', body: JSON.stringify({ summary }) });
}

export function statusPage() {
  return fetch('https://status.example.org/api/v2/status.json');
}
