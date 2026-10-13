// Read-only Jira Cloud lookup used by "Import from Jira" when adding a project.
// Credentials stay on the server; the browser only ever sees the mapped result.

import { HttpError } from './repo.js';

export async function fetchJiraIssue(jira, key) {
  if (!jira.baseUrl || !jira.email || !jira.apiToken) {
    throw new HttpError(501, 'Jira import is not set up on the server yet. Fill the project in manually for now.');
  }
  const fields = ['summary', 'assignee', 'duedate', jira.startDateField].filter(Boolean).join(',');
  const url = `${jira.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64'),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Jira. Try again in a moment.');
  }
  if (res.status === 404) throw new HttpError(404, `Jira issue ${key} was not found (or the integration account cannot see it).`);
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Jira rejected the server credentials. Ask an admin to check the Jira API token.');
  if (!res.ok) throw new HttpError(502, `Jira returned an error (${res.status}).`);
  const body = await res.json();
  const f = body.fields || {};
  const asDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  return {
    key: body.key || key,
    url: `${jira.baseUrl}/browse/${encodeURIComponent(body.key || key)}`,
    title: f.summary || '',
    assigneeName: f.assignee?.displayName || null,
    assigneeEmail: f.assignee?.emailAddress || null,
    startDate: jira.startDateField ? asDate(f[jira.startDateField]) : null,
    dueDate: asDate(f.duedate),
  };
}
