const { currentSeason } = require('../lib/footballData');

module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    hasToken: Boolean(process.env.FD_TOKEN),
    season: currentSeason(),
  });
};
