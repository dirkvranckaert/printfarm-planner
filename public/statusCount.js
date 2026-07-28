// Shared, pure job-status counting logic used by the Job Status Overview.
//
// "Attention" jobs = non-queued jobs whose status is 'Post Printing' or
// 'Paused'. This is the exact number shown on the "Job Status" menu badge.
// The frontend badge (updateStatusOverviewBadge in app.js) and the Jest test
// both import THIS function, so the test exercises the shipped count logic
// instead of re-implementing it in SQL.
//
// UMD-ish shim: browser -> global `countAttentionJobs`; Node/Jest -> module.exports.
(function (root, factory) {
  const fn = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = fn;
  } else {
    root.countAttentionJobs = fn;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return function countAttentionJobs(jobs) {
    return jobs.filter(
      j => !j.queued && (j.status === 'Post Printing' || j.status === 'Paused')
    ).length;
  };
});
