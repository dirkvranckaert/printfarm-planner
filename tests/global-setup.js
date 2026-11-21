// Jest globalSetup: runs in the parent process before workers fork, so TZ set on the real
// process.env is inherited by every worker (also on UTC CI). Setting TZ inside a test module
// is ineffective because Jest hands test code a proxied process.env.
module.exports = async () => {
  process.env.TZ = 'Europe/Brussels';
};
