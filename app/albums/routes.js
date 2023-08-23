const express = require('express');
const router = express.Router();
const controller = require('./controller')

router.get('/:id',controller.getAlbumDetailsById)


module.exports = router;
