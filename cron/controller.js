const cron = require('node-cron');
require('dotenv').config();
const puppeteer = require('puppeteer');
const { SpotifyApi } = require('@spotify/web-api-ts-sdk');
const Album= require('../models/albumModel');
const Song  = require('../models/songModel');
const Artist = require('../models/artistModel');
const PriorityArtist = require('../models/priorityArtists');
const { Redis } = require("ioredis")



const client = new Redis(process.env.REDIS_URL);

const Spotify = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET
);

function formatDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are zero-based
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}


const storeArtistSongsDataInDB = async (artistId, browser) => {
    try {
        const page = await browser.newPage();

        const url = `${process.env.DATA_SOURCE}spotify/artist/${artistId}_songs.html`;

        await page.goto(url);

        await page.waitForSelector('table');

        const tableData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length >= 2) {
                const table = tables[1];
                const rows = Array.from(table.querySelectorAll('tr'));

                const columnIndexesToExtractLinks = [0];

                return rows.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));

                    const rowData = {
                        title: columns[0] && columns[0].textContent ? columns[0].textContent : null,
                        link: columnIndexesToExtractLinks.includes(0) && columns[0] && columns[0].querySelector('a')
                            ? columns[0].querySelector('a').getAttribute('href')
                            : null,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null
                    };
                    return rowData;
                });
            }
            return null; // Return null if there's no second table
        });

        let today = new Date();
        today.setDate(today.getDate() - 2);
        const formattedDate = formatDate(today);
        // now store the songs data in the database
        if (tableData) {
            for (const data of tableData.slice(1)) {
                const parts = data?.link?.split('/');
                let songId = parts[parts.length - 1];

                let total = data?.total?.replace(/,/g, ''); // Remove commas
                let totalInteger = parseInt(total, 10); // Convert to integer

                let daily = data?.daily?.replace(/,/g, ''); // Remove commas
                let dailyInteger = parseInt(daily, 10); // Convert to integer

                //  check if the song exists in the database already
                const song = await Song.findOne({ spotifyId: songId });
                
                if (song) {
                    // update the song
                    let dailyStreamsObj = song.dailyStreams ? song.dailyStreams : {};
                    dailyStreamsObj[formattedDate] = dailyInteger;

                    let newData = {
                        totalStreams: totalInteger,
                        dailyStreams: dailyStreamsObj,
                        // isrc: songData?.external_ids?.isrc ? songData?.external_ids?.isrc : null,
                        // image: songData?.album?.images?.length > 0 ? songData?.album?.images[0]?.url : null
                    }

                    await Song.updateOne({ spotifyId: songId }, newData);

                } else {
                    let songData = await Spotify.tracks.get(songId);
                    // create the song
                    const finalString = data?.title?.startsWith('*') ? data?.title?.substring(1) : data?.title;
                    const newSong = {
                        spotifyId: songId,
                        title: finalString.trim(),
                        artistSpotifyId: artistId,
                        totalStreams: totalInteger,
                        dailyStreams: {
                            [formattedDate]: dailyInteger
                        },
                        isrc: songData?.external_ids?.isrc ? songData?.external_ids?.isrc : null,
                        image: songData?.album?.images?.length > 0 ? songData?.album?.images[0]?.url : null
                    }
                    await Song.create(newSong);
                }
            }
            return true;
        }
        return false;

    } catch (error) {
        console.log(error);
        return false;
    }

}

const storeArtistOverallDataInDB = async (artistId, browser) => {
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/artist/${artistId}_songs.html`;
        await page.goto(url);
        await page.waitForSelector('table');

        const tableData = await page.evaluate(() => {
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

        let today = new Date();
        today.setDate(today.getDate() - 2);
        const formattedDate = formatDate(today);
        // now store the artist data in the database
        if (tableData) {
            let artistData = await Spotify.artists.get(artistId);
            console.log(artistData);
            let totalStreamsData = tableData.filter(data => data.type === 'Streams')[0];
            let dailyStreamsData = tableData.filter(data => data.type === 'Daily')[0];
            let tracksData = tableData.filter(data => data.type === 'Tracks')[0];

            // check if the artist exists in the database already

            const artist = await Artist.findOne({ spotifyId: artistId });
            if (artist) {
                // update the artist
                let dailyTotalStreamsObj = artist.dailyTotalStreams ? artist.dailyTotalStreams : {};
                dailyTotalStreamsObj[formattedDate] = dailyStreamsData?.total ? parseInt(dailyStreamsData?.total?.replace(/,/g, ''), 10) : 0;

                let dailyLeadStreamsObj = artist.dailyLeadStreams ? artist.dailyLeadStreams : {};
                dailyLeadStreamsObj[formattedDate] = dailyStreamsData?.lead ? parseInt(dailyStreamsData?.lead?.replace(/,/g, ''), 10) : 0;

                let dailySoloStreamsObj = artist.dailySoloStreams ? artist.dailySoloStreams : {};
                dailySoloStreamsObj[formattedDate] = dailyStreamsData?.solo ? parseInt(dailyStreamsData?.solo?.replace(/,/g, ''), 10) : 0;

                let dailyFeatureStreamsObj = artist.dailyFeatureStreams ? artist.dailyFeatureStreams : {};
                dailyFeatureStreamsObj[formattedDate] = dailyStreamsData?.feature ? parseInt(dailyStreamsData?.feature?.replace(/,/g, ''), 10) : 0;


                let newData = {
                    followers: artistData?.followers?.total ? artistData?.followers?.total : null,
                    popularity: artistData?.popularity ? artistData?.popularity : null,
                    totalStreams: totalStreamsData?.total ? parseInt(totalStreamsData?.total?.replace(/,/g, ''), 10) : null,
                    leadStreams: totalStreamsData?.lead ? parseInt(totalStreamsData?.lead?.replace(/,/g, ''), 10) : null,
                    soloStreams: totalStreamsData?.solo ? parseInt(totalStreamsData?.solo?.replace(/,/g, ''), 10) : null,
                    featureStreams: totalStreamsData?.feature ? parseInt(totalStreamsData?.feature?.replace(/,/g, ''), 10) : null,
                    dailyTotalStreams: dailyTotalStreamsObj,
                    dailyLeadStreams: dailyLeadStreamsObj,
                    dailySoloStreams: dailySoloStreamsObj,
                    dailyFeatureStreams: dailyFeatureStreamsObj,
                    image: artistData?.images?.length > 0 ? artistData?.images[0]?.url : null
                }
                await Artist.updateOne({ spotifyId: artistId }, newData);


            } else {
                // create the artist
                const newArtist = {
                    spotifyId: artistId,
                    name: artistData?.name ? artistData?.name : null,
                    followers: artistData?.followers?.total ? artistData?.followers?.total : null,
                    popularity: artistData?.popularity ? artistData?.popularity : null,
                    genres: artistData?.genres ? artistData?.genres : [],
                    totalStreams: totalStreamsData?.total ? parseInt(totalStreamsData?.total?.replace(/,/g, ''), 10) : null,
                    leadStreams: totalStreamsData?.lead ? parseInt(totalStreamsData?.lead?.replace(/,/g, ''), 10) : null,
                    soloStreams: totalStreamsData?.solo ? parseInt(totalStreamsData?.solo?.replace(/,/g, ''), 10) : null,
                    featureStreams: totalStreamsData?.feature ? parseInt(totalStreamsData?.feature?.replace(/,/g, ''), 10) : null,
                    dailyTotalStreams: {
                        [formattedDate]: dailyStreamsData?.total ? parseInt(dailyStreamsData?.total?.replace(/,/g, ''), 10) : 0
                    },
                    dailyLeadStreams: {
                        [formattedDate]: dailyStreamsData?.lead ? parseInt(dailyStreamsData?.lead?.replace(/,/g, ''), 10) : 0
                    },
                    dailySoloStreams: {
                        [formattedDate]: dailyStreamsData?.solo ? parseInt(dailyStreamsData?.solo?.replace(/,/g, ''), 10) : 0
                    },
                    dailyFeatureStreams: {
                        [formattedDate]: dailyStreamsData?.feature ? parseInt(dailyStreamsData?.feature?.replace(/,/g, ''), 10) : 0
                    },
                    image: artistData?.images?.length > 0 ? artistData?.images[0]?.url : null
                }
                await Artist.create(newArtist);

            }
            return true;
        }
        return false;

    } catch (error) {
        console.log(error);
        return false;
    }
}


const storeArtistAlbumsDataInDB = async (artistId, browser) => {
    try {
        const page = await browser.newPage();
        const url = `${process.env.DATA_SOURCE}spotify/artist/${artistId}_albums.html`;
        await page.goto(url);
        await page.waitForSelector('table');
        const tableData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length >= 1) {
                const table = tables[0];
                const rows = Array.from(table.querySelectorAll('tr'));

                const columnIndexesToExtractLinks = [0];

                return rows.map(row => {
                    const columns = Array.from(row.querySelectorAll('td'));

                    const rowData = {
                        title: columns[0] && columns[0].textContent ? columns[0].textContent : null,
                        link: columnIndexesToExtractLinks.includes(0) && columns[0] && columns[0].querySelector('a')
                            ? columns[0].querySelector('a').getAttribute('href')
                            : null,
                        total: columns[1] && columns[1].textContent ? columns[1].textContent : null,
                        daily: columns[2] && columns[2].textContent ? columns[2].textContent : null
                    };
                    return rowData;
                });
            }
            return null; // Return null if there's no second table
        });

        let today = new Date();
        today.setDate(today.getDate() - 2);
        const formattedDate = formatDate(today);
        // now store the album data in the database
        if (tableData) {
            for (const data of tableData.slice(1)) {
                const parts = data?.link?.split('/');
                let albumId = parts[parts.length - 1];

                let total = data?.total?.replace(/,/g, ''); // Remove commas
                let totalInteger = parseInt(total, 10); // Convert to integer

                let daily = data?.daily?.replace(/,/g, ''); // Remove commas
                let dailyInteger = parseInt(daily, 10); // Convert to integer

                //  check if the song exists in the database already
                const album = await Album.findOne({ spotifyId: albumId });

                if (album) {
                    // update the album
                    let dailyStreamsObj = album.dailyStreams ? album.dailyStreams : {};
                    dailyStreamsObj[formattedDate] = dailyInteger;

                    let newData = {
                        totalStreams: totalInteger,
                        dailyStreams: dailyStreamsObj,
                        // image: albumData?.images?.length > 0 ? albumData?.images[0]?.url : null
                    }

                    await Album.updateOne({ spotifyId: albumId }, newData);


                } else {
                    // create the album
                    let albumData = await Spotify.albums.get(albumId);
                    const finalString = data?.title?.startsWith('^') ? data?.title?.substring(1) : data?.title;
                    const newAlbum = {
                        spotifyId: albumId,
                        title: finalString.trim(),
                        artistSpotifyId: artistId,
                        totalStreams: totalInteger,
                        dailyStreams: {
                            [formattedDate]: dailyInteger
                        },
                        image: albumData?.images?.length > 0 ? albumData?.images[0]?.url : null
                    }
                    await Album.create(newAlbum);
                }
            }
            return true;
        }
        return false;

    } catch (error) {
        console.log(error);
        return false;
    }

}

const storeArtistDiscographyDataInDB = async (artistId) => {
    try {
        const browser = await puppeteer.launch({
            args: [
                "--disable-setuid-sandbox",
                "--no-sandbox",
            ],
            executablePath: process.env.PRODUCTION == 'true' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
        });
        const overall = await storeArtistOverallDataInDB(artistId, browser);
        const albums = await storeArtistAlbumsDataInDB(artistId, browser);
        const songs = await storeArtistSongsDataInDB(artistId, browser);
        await browser.close();
        return {
            overall,
            albums,
            songs
        }
    } catch (error) {
        console.log(error);
    }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Run the cron job at 10:30 AM everyday
cron.schedule('30 10 * * *', async () => {
    console.log("====== CRON EXECUTOR STARTED ======")
    try {
        let results = []
        let priorityArtists = await PriorityArtist.find({})
        for (const [index, artist] of priorityArtists.entries()) {
            console.log("====== ARTIST ======", artist.spotifyId)
            let res = await storeArtistDiscographyDataInDB(artist.spotifyId)
            results.push({
            artistId: artist.spotifyId,
            result: res
            })
            console.log("====== ARTIST DONE ======", artist.spotifyId)
            
            // Wait for 40 seconds before processing the next artist
            if (index !== priorityArtists.length - 1) {
                console.log("====== Waiting for 35 seconds ======")
                await delay(35000); // 40 seconds delay
            }
        }

        console.log("====== PRIORITY ARTISTS DONE ======")
        console.log("====== RESULTS ======", results)

        await client.flushall()

    } catch (error) {
        console.log("cron error", error);
    }
},{
    scheduled: true,
    timezone: 'Asia/Kolkata' // Set the timezone to IST
});

