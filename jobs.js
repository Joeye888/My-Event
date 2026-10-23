const jobsPromise = fetch('/api/jobs', {
  headers: { 'X-Auth-Token': sessionStorage.getItem('eventKakiAuthToken') || '' }
})
  .then(response => {
    if (!response.ok) throw new Error('Unable to load jobs');
    return response.json();
  })
  .then(data => data.jobs || []);

const applicationsPromise = fetch('/api/job-applications', {
  headers: { 'X-Auth-Token': sessionStorage.getItem('eventKakiAuthToken') || '' }
})
  .then(response => response.ok ? response.json() : { applications: [] })
  .then(data => data.applications || []);
