const axios = require('axios');
const catchAsync = require('../utilities/catchAsync');
const AppError = require('../utilities/appError');
const Spotify = require('../utilities/spotify');

// Initialize the Spotify Spotify client with client credentials

exports.getArtistDetailsById = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    if (!id) {
        return next(new AppError('Please provide an artist id', 400));
    }
    const generalDetails = await Spotify.artists.get(id);
    const albums = await Spotify.artists.albums(id, "album", "ES", 50);
    const singles = await Spotify.artists.albums(id, "single", "ES", 25);
    const topTracks = await Spotify.artists.topTracks(id, "ES");
    const relatedArtists = await Spotify.artists.relatedArtists(id);
    res.status(200).json({
        status: 'success',
        data: {
            generalDetails,
            albums,
            singles,
            topTracks,
            relatedArtists
        }
    });
});