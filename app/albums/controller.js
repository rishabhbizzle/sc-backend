const axios = require('axios');
const catchAsync = require('../utilities/catchAsync');
const AppError = require('../utilities/appError');
const Spotify = require('../utilities/spotify');

exports.getAlbumDetailsById = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    if (!id) {
        return next(new AppError('Please provide an album id', 400));
    }
    const album = await Spotify.albums.get(id);
    res.status(200).json({
        status: 'success',
        data: album
    });
});