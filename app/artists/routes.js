const express = require('express');
const router = express.Router();
const controller = require('./controller')

router.get('/:id',controller.getArtistDetailsById)


module.exports = router;
