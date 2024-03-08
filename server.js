
require('dotenv').config();
const express = require('express');
const { getArtistSongsDailyData, getArtistMostPopularSongs, getArtistSpotifyApiData, getArtistAlbumsDailyData, getArtistOverallDailyData, getTrackData, getAlbumData, getNewReleases, isUserFavorite } = require('./services');
const port = 4000;
const cors = require('cors');
const app = express();
const mongoose = require('mongoose');

app.use(express.json());
app.use(cors())

async function connect() {
    try {
        mongoose.connect(process.env.MONGO_URI);
        const connection = mongoose.connection;
        connection.on('connected', () => {
            console.log('MongoDB connected successfully');
        })

        connection.on('error', (err) => {
            console.log('MongoDB connection error. Please make sure MongoDB is running. ' + err);
            process.exit();
        })

    } catch (error) {
        console.log('Something goes wrong!');
        console.log(error);
    }
}

connect();

app.get('/', (req, res) => {
    res.json({
        message: 'Hello World!',
    });
});

require('./cron/controller');

//kworb
app.get('/api/v1/daily/songs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const artistData = await getArtistSongsDailyData(id);
        return res.json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/daily/albums/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const artistData = await getArtistAlbumsDailyData(id);
        return res.json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/daily/overall/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const artistData = await getArtistOverallDailyData(id);
        return res.json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});


//spotify
app.get('/api/v1/artist/popular/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistMostPopularSongs(id);
        return res.json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

//spotify
app.get('/api/v1/artist/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistSpotifyApiData(id);
        return res.json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/track/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getTrackData(id);
        return res.json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/album/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getAlbumData(id);
        setTimeout(() => {
            return res.json({ status: 'success', data: data });
        }, 20000);
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.get('/api/v1/others/new-releases', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getNewReleases(id);
        return res.json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.post('/api/v1/user/isFavourite', async (req, res) => {
    try {
        const { id, spotifyId, type } = req.body;
        if (!id || !spotifyId || !type) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }
        const data = await isUserFavorite(type, spotifyId, id);
        setTimeout(() => {
            return res.json({ status: 'success', data: data });
        }, 10000);

    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.use('*', (req, res) => {
    res.status(404).json({
        message: 'Not Found',
    });
});


app.listen(port, () => console.log(`Example app listening on port ${port}!`));