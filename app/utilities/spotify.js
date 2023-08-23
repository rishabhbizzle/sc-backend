const { SpotifyApi } = require('@spotify/web-api-ts-sdk');

// Initialize the Spotify API client with client credentials

const Spotify = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET
);

module.exports = Spotify;