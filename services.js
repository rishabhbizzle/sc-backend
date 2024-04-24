require('dotenv').config();
const puppeteer = require('puppeteer');
const { SpotifyApi } = require('@spotify/web-api-ts-sdk');
const Album = require('./models/albumModel');
const Song = require('./models/songModel');
const Artist = require('./models/artistModel');
const UserFavorite = require('./models/userModel');
const PriorityArtist = require('./models/priorityArtists');
const axios = require('axios');
// Initialize the Spotify API client with client credentials

const Spotify = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET
);



const getArtistSongsDailyData = async (artistId) => {
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
        const songsData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length >= 2) {
                const table = tables[1];
                const rows = Array.from(table.querySelectorAll('tr'));

                const columnIndexesToExtractLinks = [0];

                return rows?.slice(1)?.map(row => {
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

                return rows?.slice(1)?.map(row => {
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

                return rows?.slice(1)?.map(row => {
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
            console.log(process.env.LAST_FM_API_KEY)
            lastFmData = await axios.get(`http://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${artist.name}&api_key=${process.env.LAST_FM_API_KEY}&format=json`)
        } catch (error) {
            console.error(error);
        }

        return {
            ...artist,
            ...(lastFmData?.data?.artist ? {
                lastFmStats: lastFmData?.data?.artist?.stats,
                onTour: lastFmData?.data?.artist?.ontour,
                summary: removeAnchorTag(lastFmData?.data?.artist?.bio?.summary)
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


const getAlbumData = async (id) => {
    console.log('fetching album data:', id)
    try {
        const albumDetails = await Spotify.albums.get(id, "US")
        let streamingData = await Album.findOne({ spotifyId: id })

        let lastFmData;
        const artist = albumDetails?.artists[0]?.name
        try {
            lastFmData = await axios.get(`http://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${artist}&album=${albumDetails?.name}&api_key=${process.env.LAST_FM_API_KEY}&format=json`)
        } catch (error) {
            console.error(error);
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

const getTrackData = async (id) => {
    try {
        console.log('fetching track data:', id)
        const trackDetails = await Spotify.tracks.get(id, "US")
        const trackFeatures = await Spotify.tracks.audioFeatures(id);
        // const trackAnalysis = await Spotify.tracks.audioAnalysis(id);
        let streamingData = await Song.findOne({ spotifyId: id })
        const isrc = trackDetails?.external_ids?.isrc
        if (isrc) {
            // get all  version of the track from earliest to latest using updatedAt
            let allTrackVersions = await Song.find({ isrc: isrc }).sort({ updatedAt: -1 })
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

const getArtistSocialData = async (id) => {
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
        const data = await PriorityArtist.findOne({ spotifyId: id })

        if (!data?.cmId) {
            return null
        }
        const page = await browser.newPage();
        // Replace the URL with the URL of the webpage you want to scrape
        await page.goto(`https://app.chartmetric.com/artist/${data?.cmId}`, { waitUntil: 'domcontentloaded' });

        // Wait until the data is present in the page
        // await page.waitForFunction(() => {
        //     const dataSourceIcons = document.querySelectorAll('.DataSourcePanel_dataSourcesIcons__njYri a');
        //     return dataSourceIcons.length > 0;
        // }, { timeout: 10000 });

        // // Extracting data from the HTML
        // const socialLinks = await page.evaluate(() => {
        //     const dataSourceIcons = document.querySelectorAll('.DataSourcePanel_dataSourcesIcons__njYri a');
        //     const sources = [];
        //     function extractPlatformFromUrl(url) {
        //         if (!url) return null;

        //         const domains = {
        //             'spotify': /open.spotify.com/i,
        //             'itunes': /itunes.apple.com/i,
        //             'amazon': /music.amazon.com/i,
        //             'deezer': /deezer.com/i,
        //             'youtube': /youtube.com/i,
        //             'soundcloud': /soundcloud.com/i,
        //             'pandora': /pandora.com/i,
        //             'genius': /genius.com/i,
        //             'shazam': /shazam.com/i,
        //             'line': /music.line.me/i,
        //             'melon': /melon.com/i,
        //             'instagram': /instagram.com/i,
        //             'facebook': /facebook.com/i,
        //             'tiktok': /tiktok.com/i,
        //             'youtubeforartist': /charts.youtube.com/i,
        //             'twitter': /twitter.com/i,
        //             'wikipedia': /wikipedia.org/i,
        //             'musicbrainz': /musicbrainz.org/i,
        //             'discogs': /discogs.com/i,
        //             'songkick': /songkick.com/i,
        //             'bandsintown': /bandsintown.com/i,
        //             'tvmaze': /tvmaze.com/i,
        //         };

        //         for (const [platform, regex] of Object.entries(domains)) {
        //             if (regex.test(url)) {
        //                 return platform;
        //             }
        //         }

        //         return null;
        //     }
        //     dataSourceIcons.forEach(icon => {
        //         const link = icon.getAttribute('href')
        //         const platform = extractPlatformFromUrl(link);
        //         const source = {
        //             link,
        //             platform
        //         };
        //         sources.push(source);
        //     });
        //     return sources;
        // });

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

    } catch (error) {
        console.log('error from getArtistSocialdata:', id, error);
        return null
    } finally {
        await browser.close();
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
            // check if this artists exist in our db or not

            const artistExist = await getArtistStreamingData(artist.spotifyId)
            let streams;
            let daily;
            if (!artistExist) {
                const overAllData = await getArtistOverallDailyData(artist.spotifyId)
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
                return rows?.slice(1, 101)?.map(row => {
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
                return rows?.slice(1, 101)?.map(row => {
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
                return rows?.slice(1, 101)?.map(row => {
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
                return rows?.slice(1, 101)?.map(row => {
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
            // check if user has already added 5 favourites of artist type if yes dont add more
            if (type === "artist") {
                let artistFavourites = await UserFavorite.find({ kindeId: id, type: type })
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
        const index = type === "holiday" ? 9 : 8;
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
            if (tables.length > 8) {
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
            if (tables.length > 10) {
                const table = tables[10];
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

const getMostStreamedAlbumInSingle = async (mode = 'day') => {
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
        const overallData = await page.evaluate((mode) => {
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
            if (tables.length > mode === 'day' ? 13 : 14) {
                const table = tables[mode === 'day' ? 13 : 14];
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows?.slice(1)?.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));
                    const rowData = {
                        name: columns[0] && columns[0].textContent ? columns[0].textContent : null,
                        artist: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        streams: columns[2] && columns[2].textContent ? columns[2].textContent : null,
                        tracks: columns[3] && columns[3].textContent ? columns[3].textContent : null,
                        average: columns[4] && columns[4].textContent ? columns[4].textContent : null,
                        dateAchieved: columns[6] && columns[6].textContent ? columns[6].textContent : null,
                    };
                    return rowData;
                });
            }
            return null;
        }, mode);
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
    getMostStreamedSongsInSingleWeek,
    getMostStreamedAlbumInSingle,
    getArtistSocialData
}