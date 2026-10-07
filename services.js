require('dotenv').config();
const { withPage } = require('./utilities/browser');
const { SpotifyApi } = require('@spotify/web-api-ts-sdk');
const Album = require('./models/albumModel');
const Song = require('./models/songModel');
const Artist = require('./models/artistModel');
const UserFavorite = require('./models/userModel');
const PriorityArtist = require('./models/priorityArtists');
const axios = require('axios');
const qqMusic = require('qq-music-api');
const kworb = require('./scrapers/kworb');
const wikipedia = require('./scrapers/wikipedia');

// Outbound REST calls (Last.fm, t4ils) must never hang a request.
const EXTERNAL_API_TIMEOUT_MS = 8000;
// Chartmetric now sits behind a login wall and its CSS-module class names are
// hashed per deploy, so the scrape below cannot find its selectors and used to
// burn a 30s browser slot on every artist page view before returning null.
// It is off unless explicitly re-enabled once a working approach exists.
const CHARTMETRIC_SCRAPE_ENABLED = process.env.CHARTMETRIC_SCRAPE_ENABLED === 'true';


// Initialize the Spotify API client with client credentials

const Spotify = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET
);


// ---------------------------------------------------------------------------
// kworb.net (static HTML, fetched over plain HTTP; see scrapers/kworb.js)
//
// An artist that kworb does not track yields [] exactly like before. An
// upstream failure (timeout, 5xx, network) THROWS so the route can answer 503
// and nothing empty gets cached for six hours.
// ---------------------------------------------------------------------------

const getArtistSongsDailyData = async (artistId) => {
    const { songs, notFound } = await kworb.getArtistSongsPage(artistId);
    return notFound || !songs ? [] : songs;
}

const getArtistAlbumsDailyData = async (artistId) => {
    const { albums, notFound } = await kworb.getArtistAlbumsPage(artistId);
    return notFound || !albums ? [] : albums;
}

const getArtistOverallDailyData = async (artistId) => {
    const { overall, notFound } = await kworb.getArtistSongsPage(artistId);
    return notFound || !overall ? [] : overall;
}

const getMostStreamedArtists = async (limit = 100) => {
    console.log('fetching most streamed artists')
    return (await kworb.getMostStreamedArtists(limit)) || [];
}

const getMostMonthlyListeners = async (limit = 100) => {
    console.log('fetching most monthly listeners')
    return (await kworb.getMostMonthlyListeners(limit)) || [];
}

const getMostStreamedSongs = async (year) => {
    return (await kworb.getMostStreamedSongs(year)) || [];
}

const getMostStreamedAlbums = async () => {
    return (await kworb.getMostStreamedAlbums()) || [];
}

const getMostViewedYTVideos = async (year) => {
    return (await kworb.getMostViewedYTVideos(year)) || [];
}

// ---------------------------------------------------------------------------
// Wikipedia "List of Spotify streaming records" (see scrapers/wikipedia.js)
// ---------------------------------------------------------------------------

const getMostStreamedSongsInSingleDay = async (type) => {
    return wikipedia.getMostStreamedSongsInSingleDay(type);
}

const getMostStreamedSongsInSingleWeek = async () => {
    return wikipedia.getMostStreamedSongsInSingleWeek();
}

const getMostStreamedAlbumInSingle = async (mode = 'day') => {
    return wikipedia.getMostStreamedAlbumInSingle(mode);
}

// ---------------------------------------------------------------------------
// Chartmetric social stats (headless browser; disabled by default, see above)
// ---------------------------------------------------------------------------

const getArtistSocialData = async (id) => {
    if (!CHARTMETRIC_SCRAPE_ENABLED) return null
    try {
        const data = await PriorityArtist.findOne({ spotifyId: id })
        if (!data?.cmId) {
            return null
        }
        return await withPage(async (page) => {
            await page.goto(`https://app.chartmetric.com/artist/${data?.cmId}`, { waitUntil: 'domcontentloaded' });

            await page.waitForSelector('.StatTilesRow_value__r3Iqn');
            const socialFootprint = await page.$eval('.StatTilesRow_value__r3Iqn', element => element?.textContent);

            await page.waitForSelector('.TopStats_topStatsContainerItem__3SRla');

            const summaryStats = await page.evaluate(() => {
                const summaryItems = Array.from(document.querySelectorAll('.TopStats_topStatsContainerItem__3SRla'));

                const stats = summaryItems.map(item => {
                    const platformNameElement = item.querySelector('div > div:nth-child(1) > div');
                    const platformName = platformNameElement?.textContent?.trim();
                    const dataRows = Array.from(item.querySelectorAll('div.TopStats_topStatsContainerItemDetails___Mob8 > div.TopStats_detailRow__m6kRi'));
                    const platformData = {};

                    dataRows.forEach(row => {
                        const label = row.querySelector('.TopStats_statName__hZKYr > p')?.textContent?.trim();
                        const value = row.querySelector('.TopStats_activeToggle__UrDUm > p')?.textContent?.trim();
                        if (label) platformData[label] = value;
                    });

                    return {
                        platform: platformName,
                        data: platformData
                    };
                });

                return stats;
            });

            return { socialSummary: summaryStats, socialFootprint: socialFootprint };
        });
    } catch (error) {
        console.log('error from getArtistSocialdata:', id, error?.message);
        return null
    }
}


function removeAnchorTag(summary) {
    if (!summary) return null;
    const pattern = /<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>.*?<\/a>/gi;
    return summary.replace(pattern, '');
}

const getArtistSpotifyApiData = async (id) => {
    console.log('fetching artist data:', id)
    try {
        const artist = await Spotify.artists.get(id)
        // more details about the artist
        let lastFmData;
        try {
            lastFmData = await axios.get(`http://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${artist.name}&api_key=${process.env.LAST_FM_API_KEY}&format=json`, { timeout: EXTERNAL_API_TIMEOUT_MS })
        } catch (error) {
            console.warn('last.fm unavailable:', error?.message);
        }

        let additionalData;
        try {
            const res = await axios.get(`https://api.t4ils.dev/getArtist?id=${id}`, { timeout: EXTERNAL_API_TIMEOUT_MS })
            additionalData = res?.data?.data?.data?.artistUnion
        } catch (error) {
            console.warn('t4ils unavailable:', error?.message);
        }
        return {
            ...artist,
            ...(lastFmData?.data?.artist ? {
                lastFmStats: lastFmData?.data?.artist?.stats,
                onTour: lastFmData?.data?.artist?.ontour,
                summary: removeAnchorTag(lastFmData?.data?.artist?.bio?.summary)
            } : {}),
            ...(additionalData ? {
                events: additionalData?.goods?.events,
                otherStats: additionalData?.stats,
                visuals: additionalData?.visuals,
                preRelease: additionalData?.preRelease,

            } : {})
        }
    } catch (error) {
        console.error(error);
        return null
    }
}

const getArtistMostPopularSongs = async (id) => {
    try {
        const topTracks = await Spotify.artists.topTracks(id, "US");
        return topTracks.tracks
    } catch (error) {
        console.error(error);
        return []
    }
}


const getAlbumData = async (id, metaData = false) => {
    console.log('fetching album data:', id)
    try {
        const albumDetails = await Spotify.albums.get(id, "US")

        let streamingData;
        if (!metaData) {
            streamingData = await Album.findOne({ spotifyId: id }).lean()
        }

        let lastFmData;
        const artist = albumDetails?.artists[0]?.name
        try {
            lastFmData = await axios.get(`http://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${artist}&album=${albumDetails?.name}&api_key=${process.env.LAST_FM_API_KEY}&format=json`, { timeout: EXTERNAL_API_TIMEOUT_MS })
        } catch (error) {
            console.warn('last.fm unavailable:', error?.message);
        }
        return {
            albumDetails: {
                ...albumDetails,
                ...(lastFmData?.data?.album ? {
                    lastFmStats: lastFmData?.data?.album?.stats,
                    summary: removeAnchorTag(lastFmData?.data?.album?.wiki?.summary)
                } : {})

            }, streamingData
        }
    } catch (error) {
        console.error(error);
        return { albumDetails: null, streamingData: null }
    }
}

const getTrackData = async (id, metaData = false) => {
    try {
        console.log('fetching track data:', id)
        const trackDetails = await Spotify.tracks.get(id, "US")
        let trackFeatures
        let streamingData
        if (!metaData) {
            try {
                trackFeatures = await Spotify.tracks.audioFeatures(id);
            } catch (error) {
                // Spotify restricted this endpoint for newer apps; the track page works without it.
                console.warn('audioFeatures unavailable for', id, error?.message);
                trackFeatures = null;
            }
            streamingData = await Song.findOne({ spotifyId: id }).lean()
            // const trackAnalysis = await Spotify.tracks.audioAnalysis(id);
            const isrc = trackDetails?.external_ids?.isrc
            if (isrc) {
                // get all  version of the track from earliest to latest using updatedAt
                let allTrackVersions = await Song.find({ isrc: isrc }).sort({ updatedAt: -1 }).lean()
                if (allTrackVersions.length > 0) {
                    // maintain the current and collect all key values from dailyStreams obj from the track versions
                    let dailyStreams = {}

                    if (streamingData?.dailyStreams) {
                        dailyStreams = { ...streamingData.dailyStreams };
                    }

                    for (let version of allTrackVersions) {
                        dailyStreams = { ...dailyStreams, ...version.dailyStreams }
                    }

                    // get the latest version of the track by comparing updatedAt of all versions + the already one in streamingData
                    let latestVersion
                    const highestStreams = allTrackVersions.reduce((prev, current) => (prev.totalStreams > current.totalStreams) ? prev : current)

                    if (streamingData?.totalStreams) {
                        // get the obj with highest totalStreams from all versions
                        latestVersion = highestStreams.totalStreams > streamingData?.totalStreams ? highestStreams : streamingData
                    } else {
                        latestVersion = highestStreams
                    }
                    streamingData = latestVersion


                    dailyStreams = { ...dailyStreams, ...latestVersion.dailyStreams }

                    // sort the dailyStreams obj by date early to latest
                    const sortedDailyStreams = Object.fromEntries(
                        Object.entries(dailyStreams)
                            .sort((a, b) => {
                                const dateA = new Date(a[0].split('-').reverse().join('-'));
                                const dateB = new Date(b[0].split('-').reverse().join('-'));
                                return dateA - dateB;
                            })
                    );

                    streamingData.dailyStreams = sortedDailyStreams
                }
            }
        }
        return { trackDetails, streamingData, trackFeatures }
    } catch (error) {
        console.error(error);
        return { trackDetails: null, streamingData: null }
    }
}

const getNewReleases = async (limit = 50) => {
    try {
        const data = await Spotify.playlists.getPlaylistItems('37i9dQZF1DWXJfnUiYjUKT', 'ES', null, limit)
        return data
    } catch (error) {
        console.error(error);
        throw error
    }
}

const getArtistStreamingData = async (id) => {
    try {
        const streamingData = await Artist.findOne({ spotifyId: id }).lean()
        return streamingData
    } catch (error) {
        console.error(error);
        return null
    }
}


const getUserFavourites = async (kindeId) => {
    try {
        let userFavourites = await UserFavorite.find({ kindeId: kindeId }).lean()
        // divide the favourites into types
        let artistFavourites = userFavourites.filter(fav => fav.type === "artist")
        let albumFavourites = userFavourites.filter(fav => fav.type === "album")
        let trackFavourites = userFavourites.filter(fav => fav.type === "track")
        return { artistFavourites, albumFavourites, trackFavourites }
    } catch (error) {
        console.error(error);
        return { artistFavourites: [], albumFavourites: [], trackFavourites: [] }
    }
}

const getDashboardArtistRankingData = async (userId) => {
    try {
        let responseData = [];
        const { artistFavourites } = await getUserFavourites(userId)
        responseData = await Promise.all(artistFavourites.map(async (artist) => {
            // check if this artists exist in our db or not

            const artistExist = await getArtistStreamingData(artist.spotifyId)
            let streams;
            let daily;
            if (!artistExist) {
                let overAllData = []
                try {
                    overAllData = await getArtistOverallDailyData(artist.spotifyId)
                } catch (error) {
                    console.error('dashboard: kworb unavailable for', artist.spotifyId, error?.message)
                }
                // get the streams, daily obj from the overall data
                streams = overAllData.find(data => data.type === "Streams")?.total
                daily = overAllData.find(data => data.type === "Daily")?.total

            } else {
                streams = artistExist.totalStreams?.toLocaleString('en-US')
                // get the latest daily streams from the dailyStreams in artist data
                const sortedDailyStreams = Object.fromEntries(
                    Object.entries(artistExist?.dailyTotalStreams)
                        .sort((a, b) => {
                            const dateA = new Date(a[0].split('-').reverse().join('-'));
                            const dateB = new Date(b[0].split('-').reverse().join('-'));
                            return dateA - dateB;
                        })
                );
                const latestDailyStreams = Object.values(sortedDailyStreams).pop()
                daily = latestDailyStreams?.toLocaleString('en-US')
            }

            let artistData = {
                streams: streams,
                dailyStreams: daily,
                spotifyId: artist.spotifyId,
                image: artist.image,
                name: artist.name
            }

            return artistData
        }))
        return responseData?.sort((a, b) => {
            const aNum = parseInt(a?.dailyStreams?.replace(/,/g, ''))
            const bNum = parseInt(b?.dailyStreams?.replace(/,/g, ''))
            return bNum - aNum
        }) || []

    } catch (error) {
        console.error(error);
        return []
    }
}


const isUserFavorite = async (type, spotifyId, id) => {
    try {
        let userFavourite = await UserFavorite.findOne({ kindeId: id, type: type, spotifyId: spotifyId }).lean()
        if (userFavourite) {
            return true
        }
        return false
    } catch (error) {
        console.error(error);
        throw error
    }
}

const getRecomendations = async (type) => {
    try {
        let recomendations;
        if (type === "artist") {
            // get the random 10 artists from database
            recomendations = await Artist.aggregate([
                { $match: { image: { $exists: true } } },
                { $sample: { size: 10 } }])
        } else if (type === "track") {
            // get the random 10 songs from database
            recomendations = await Song.aggregate([
                { $match: { image: { $exists: true } } },
                { $sample: { size: 10 } }])
        } else if (type === "album") {
            // get the random 10 albums from database
            recomendations = await Album.aggregate([
                { $match: { image: { $exists: true } } },
                { $sample: { size: 10 } }])
        }
        return recomendations
    } catch (error) {
        console.error(error);
        return []
    }
}


const markFavourite = async (id, type, spotifyId, image, name) => {
    try {
        let userFavourite = await UserFavorite.findOne({ kindeId: id, type: type, spotifyId: spotifyId }).lean()
        if (userFavourite) {
            await UserFavorite.deleteOne({ kindeId: id, type: type, spotifyId: spotifyId })
            return { message: "Removed from favourites", type: "success" }
        } else {
            // check if user has already added 5 favourites of artist type if yes dont add more
            if (type === "artist") {
                let artistFavourites = await UserFavorite.find({ kindeId: id, type: type }).lean()
                if (artistFavourites.length >= 5) {
                    throw new Error("You can only add upto 5 favourite artists")
                }
            }
            await UserFavorite.create({ kindeId: id, type: type, spotifyId: spotifyId, image: image, name: name })
            return { message: "Added to favourites", type: "success" }
        }
    }
    catch (error) {
        console.error(error);
        throw error
    }
}


const getLastFmTopTracks = async (page = 1, limit = 10) => {
    try {
        const data = await axios.get(`http://ws.audioscrobbler.com/2.0/?method=chart.gettoptracks&api_key=${process.env.LAST_FM_API_KEY}&format=json&page=${page}&limit=${limit}`, { timeout: EXTERNAL_API_TIMEOUT_MS })
        return data?.data?.tracks
    } catch (error) {
        console.error(error);
        throw error
    }
}

const getTopTracksBasedOnCharts = async (country = null, limit = 50) => {
    try {
        const data = await Spotify.playlists.getPlaylistItems(country ? country : '37i9dQZEVXbMDoHDwVN2tF', 'ES', null, limit)
        return data
    } catch (error) {
        console.error(error);
        throw error
    }
}

const getTopViralTracks = async (limit = 50) => {
    try {
        const data = await Spotify.playlists.getPlaylistItems('37i9dQZEVXbLiRSasKsNU9', 'ES', null, limit)
        return data
    } catch (error) {
        console.error(error);
        throw error
    }
}

const getQQMusicTopTracks = async (limit = 100) => {
    try {
        const data = await qqMusic.api('/top', { pageSize: limit })
        return data
    } catch (error) {
        console.error(error);
        throw error
    }
}


const searchService = async (searchText, type) => {
    try {
        const results = await Spotify.search(searchText, type, 'ES', 10);
        return results
    } catch (error) {
        console.log(error);
        return null
    }
}


module.exports = {
    getArtistSongsDailyData,
    getArtistAlbumsDailyData,
    getArtistOverallDailyData,
    getArtistSpotifyApiData,
    getArtistMostPopularSongs,
    getAlbumData,
    getTrackData,
    getNewReleases,
    getArtistStreamingData,
    getDashboardArtistRankingData,
    isUserFavorite,
    getRecomendations,
    getUserFavourites,
    getMostStreamedArtists,
    getMostMonthlyListeners,
    getMostStreamedSongs,
    getMostStreamedAlbums,
    markFavourite,
    getMostStreamedSongsInSingleDay,
    getMostStreamedSongsInSingleWeek,
    getMostStreamedAlbumInSingle,
    getArtistSocialData,
    getLastFmTopTracks,
    getTopTracksBasedOnCharts,
    getQQMusicTopTracks,
    getTopViralTracks,
    getMostViewedYTVideos,
    searchService
}