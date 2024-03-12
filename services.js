require('dotenv').config();
const puppeteer = require('puppeteer');
const { SpotifyApi } = require('@spotify/web-api-ts-sdk');
const Album = require('./models/albumModel');
const Song = require('./models/songModel');
const Artist = require('./models/artistModel');
const UserFavorite = require('./models/userModel');

// Initialize the Spotify API client with client credentials

const Spotify = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET
);



const getArtistSongsDailyData = async (artistId) => {
    try {
        console.log('fecthing songs data')
        const browser = await puppeteer.launch({
            args: [
                "--disable-setuid-sandbox",
                "--no-sandbox",
                "--single-process",
                "--no-zygote",
            ],
            executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
        });
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/artist/${artistId}_songs.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const songsData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length >= 2) {
                const table = tables[1];
                const rows = Array.from(table.querySelectorAll('tr'));

                const columnIndexesToExtractLinks = [0];

                return rows.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    let songTitle = columns[0] && columns[0].textContent ? columns[0].textContent?.startsWith('*') ? columns[0].textContent?.substring(1)?.trim() : columns[0].textContent?.trim() : null
                    let link = columnIndexesToExtractLinks.includes(0) && columns[0] && columns[0].querySelector('a') ? columns[0].querySelector('a').getAttribute('href') : null
                    let parts = link?.split('/');
                    let id = parts && parts[parts.length - 1];
                    const rowData = {
                        id: id,
                        title: songTitle,
                        link: link,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null
                    };
                    return rowData;
                });
            }
            return null;
        });
        await browser.close();
        return songsData;
    } catch (error) {
        console.error(error);
        await browser.close();
        return []
    }

}

const getArtistAlbumsDailyData = async (artistId) => {
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/artist/${artistId}_albums.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const albumData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length >= 1) {
                const table = tables[0];
                const rows = Array.from(table.querySelectorAll('tr'));

                const columnIndexesToExtractLinks = [0];

                return rows.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    let albumTitle = columns[0] && columns[0].textContent ? columns[0].textContent?.startsWith('^') ? columns[0].textContent?.substring(1)?.trim() : columns[0].textContent?.trim() : null
                    let albumLink = columnIndexesToExtractLinks.includes(0) && columns[0] && columns[0].querySelector('a') ? columns[0].querySelector('a').getAttribute('href') : null
                    let parts = albumLink?.split('/');
                    let id = parts && parts[parts.length - 1];

                    const rowData = {
                        id: id,
                        title: albumTitle,
                        link: albumLink,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null
                    };


                    return rowData;
                });
            }
            return null; // Return null if there's no second table
        });

        return albumData;
    } catch (error) {
        console.error(error);
        return []
    } finally {
        await browser.close();
    }
}


const getArtistOverallDailyData = async (artistId) => {
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/artist/${artistId}_songs.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length >= 2) {
                const table = tables[0]; // Select the second table
                const rows = Array.from(table.querySelectorAll('tr'));

                return rows.slice(1).map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    const rowData = {
                        type: columns[0] && columns[0].textContent ? columns[0].textContent : null,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        lead: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                        solo: columns[3] && columns[3].textContent ? columns[3].textContent : null,
                        feature: columns[4] && columns[4].textContent ? columns[4].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        });
        return overallData;
    } catch (error) {
        console.error(error);
        return []
    } finally {
        await browser.close();
    }
}


const getArtistSpotifyApiData = async (id) => {
    try {
        const artist = await Spotify.artists.get(id)
        return artist
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


const getAlbumData = async (id) => {
    try {
        console.log('fetching album data:', id)
        const albumDetails = await Spotify.albums.get(id, "US")
        let streamingData = await Album.findOne({ spotifyId: id })
        return { albumDetails, streamingData }
    } catch (error) {
        console.error(error);
        return { albumDetails: null, streamingData: null }
    }
}

const getTrackData = async (id) => {
    try {
        console.log('fetching track data:', id)
        const trackDetails = await Spotify.tracks.get(id, "US")
        const trackFeatures = await Spotify.tracks.audioFeatures(id);
        // const trackAnalysis = await Spotify.tracks.audioAnalysis(id);
        let streamingData 
        const isrc = trackDetails?.external_ids?.isrc
        if (isrc) {
            // get all  version of the track from earliest to latest using updatedAt
            let allTrackVersions = await Song.find({ isrc: isrc }).sort({ updatedAt: -1 })

            // collect all key values from dailyStreams obj from the track versions
            let dailyStreams = {}

            for (let version of allTrackVersions) {
                dailyStreams = {  ...version.dailyStreams, ...dailyStreams}
            }
            // get the latest version of the track
            streamingData = allTrackVersions[0]
            streamingData.dailyStreams = dailyStreams

        } else {
            streamingData = await Song.findOne({ spotifyId: id })
        }
        return { trackDetails, streamingData, trackFeatures }
    } catch (error) {
        console.error(error);
        return { trackDetails: null, streamingData: null }
    }
}

const getNewReleases = async () => {
    try {
        let newReleases = await Spotify.browse.getNewReleases("US", 10)
        return newReleases
    } catch (error) {
        console.error(error);
        return []
    }
}

const getArtistStreamingData = async (id) => {
    try {
        const streamingData = await Artist.findOne({ spotifyId: id })
        return streamingData
    } catch (error) {
        console.error(error);
        return null
    }
}
const getUserFavourites = async (kindeId) => {
    try {
        let userFavourites = await UserFavorite.find({ kindeId: kindeId })
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
        for (let artist of artistFavourites) {
            const overAllData = await getArtistOverallDailyData(artist.spotifyId)
            // get the streams, daily obj from the overall data
            let streams = overAllData.find(data => data.type === "Streams")
            let daily = overAllData.find(data => data.type === "Daily")

            let artistData = {
                streams: streams?.total,
                dailyStreams: daily?.total,
                spotifyId: artist.spotifyId,
                image: artist.image,
                name: artist.name
            }

            responseData.push(artistData)
        }

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
        let userFavourite = await UserFavorite.findOne({ kindeId: id, type: type, spotifyId: spotifyId })
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


const getMostStreamedArtists = async (limit) => {
    console.log('fetching most streamed artists')
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/artists.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length > 0) {
                const table = tables[0];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows.slice(1, 101).map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    let link = columns[0] && columns[0].querySelector('a') ? columns[0].querySelector('a').getAttribute('href') : null
                    let parts = link && link?.split('/');
                    let id = parts && parts[parts.length - 1]?.split('_');
                    id = id && id[0];
                    const rowData = {
                        id: id,
                        name: columns[0] && columns[0].textContent ? columns[0].textContent : null,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                        lead: columns[3] && columns[3].textContent ? columns[3].textContent : null,
                        solo: columns[4] && columns[4].textContent ? columns[4].textContent : null,
                        feature: columns[5] && columns[5].textContent ? columns[5].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        });
        return overallData;
    } catch (error) {
        console.error(error);
        throw error
    } finally {
        await browser.close();
    }
}


const getMostMonthlyListeners = async (limit = 100) => {
    console.log('fetching most streamed artists')
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/listeners.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length > 0) {
                const table = tables[0];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows.slice(1, 101).map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    let link = columns[0] && columns[0].querySelector('a') ? columns[0].querySelector('a').getAttribute('href') : null
                    let parts = link && link?.split('/');
                    let id = parts && parts[parts.length - 1]?.split('_');
                    id = id && id[0];

                    const rowData = {
                        id: id,
                        name: columns[0] && columns[0].textContent ? columns[0].textContent : null,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                        peak: columns[4] && columns[4].textContent ? columns[4].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        });
        return overallData;
    } catch (error) {
        console.error(error);
        throw error
    } finally {
        console.log('closing browser')
        await browser.close();
    }
}

const getMostStreamedSongs = async (year) => {
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = year ? `${process.env.DATA_SOURCE}spotify/songs_${year}.html` : `${process.env.DATA_SOURCE}spotify/songs.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length > 0) {
                const table = tables[0];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows.slice(1, 101).map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));

                    let nameText = columns[0] && columns[0].textContent ? columns[0].textContent : null
                    let parts = nameText && nameText?.split('-');
                    let artistName;
                    let songName;
                    if (parts?.length > 1) {
                        artistName = parts && parts[0]?.trim()
                        songName = parts && parts[1]?.trim()
                    }

                    const rowData = {
                        name: songName,
                        artist: artistName,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        });
        return overallData;
    } catch (error) {
        console.error(error);
        throw error
    } finally {
        console.log('closing browser')
        await browser.close();
    }
}

const getMostStreamedAlbums = async (year) => {
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/albums.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length > 0) {
                const table = tables[0];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows.slice(1, 101).map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));

                    let nameText = columns[0] && columns[0].textContent ? columns[0].textContent : null
                    let parts = nameText && nameText?.split('-');
                    let artistName;
                    let songName;
                    if (parts?.length > 1) {
                        artistName = parts && parts[0]?.trim()
                        songName = parts && parts[1]?.trim()
                    }

                    const rowData = {
                        name: songName,
                        artist: artistName,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        });
        return overallData;
    } catch (error) {
        console.error(error);
        throw error
    } finally {
        console.log('closing browser')
        await browser.close();
    }
}

const markFavourite = async (id, type, spotifyId, image, name) => {
    try {
        let userFavourite = await UserFavorite.findOne({ kindeId: id, type: type, spotifyId: spotifyId })
        if (userFavourite) {
            await UserFavorite.deleteOne({ kindeId: id, type: type, spotifyId: spotifyId })
            return { message: "Removed from favourites", type: "success" }
        } else {
            await UserFavorite.create({ kindeId: id, type: type, spotifyId: spotifyId, image: image, name: name })
            return { message: "Added to favourites", type: "success" }
        }
    }
    catch (error) {
        console.error(error);
        throw error
    }
}


const getMostStreamedSongsInSingleDay = async (type) => {
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const index = type === "holiday" ? 8 : 7;
        const page = await browser.newPage();
        const url = `https://en.wikipedia.org/wiki/List_of_Spotify_streaming_records`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate((index) => {
            function formatWikiString(inputString) {
                try {

                    inputString = inputString.trim().replace(/^,|,$/g, '');
                    let parsedString;
                    try {
                        parsedString = JSON.parse(`[${inputString}]`);
                    } catch (error) {
                        console.error("Error parsing input string:", error);
                        return null;
                    }
                    return parsedString.join(', ');
                } catch (error) {
                    return null
                }
            }
            const tables = document.querySelectorAll('table');
            if (tables.length > 7) {
                const table = tables[index];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows?.slice(1)?.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    const rowData = {
                        name: columns[0] && columns[0].textContent ? formatWikiString(columns[0].textContent) : null,
                        artist: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        streams: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                        // dateAchieved: columns[3] && columns[3].textContent ? columns[3].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        }, index);
        return overallData;
    } catch (error) {
        console.error(error);
        throw error
    } finally {
        console.log('closing browser')
        await browser.close();
    }
}

const getMostStreamedSongsInSingleWeek = async () => {
    const browser = await puppeteer.launch({
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
    });
    try {
        const page = await browser.newPage();
        const url = `https://en.wikipedia.org/wiki/List_of_Spotify_streaming_records`;
        await page.goto(url);
        await page.waitForSelector('table');
        const overallData = await page.evaluate(() => {
            function formatWikiString(inputString) {
                try {

                    inputString = inputString.trim().replace(/^,|,$/g, '');
                    let parsedString;
                    try {
                        parsedString = JSON.parse(`[${inputString}]`);
                    } catch (error) {
                        console.error("Error parsing input string:", error);
                        return null;
                    }
                    return parsedString.join(', ');
                } catch (error) {
                    return null
                }
            }
            const tables = document.querySelectorAll('table');
            if (tables.length > 9) {
                const table = tables[9];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows?.slice(1)?.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    const rowData = {
                        name: columns[0] && columns[0].textContent ? formatWikiString(columns[0].textContent) : null,
                        artist: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        streams: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                        dateAchieved: columns[4] && columns[4].textContent ? columns[4].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        });
        return overallData;
    } catch (error) {
        console.error(error);
        throw error
    } finally {
        console.log('closing browser')
        await browser.close();
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
    getMostStreamedSongsInSingleWeek
}