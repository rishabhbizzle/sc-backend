const express = require('express');
const app = express();
const albumRoutes = require('./albums/routes')
const artistRoutes = require('./artists/routes')

app.use('/api/v1/album', albumRoutes);

app.use('/api/v1/artist', artistRoutes);


app.use('*', (req, res) => {
  res.status(404).json({
    message: 'Not Fodsdund',
  });
});



module.exports = app;
