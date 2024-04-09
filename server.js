
require('dotenv').config();
const express = require('express');
const { getArtistSongsDailyData, getArtistMostPopularSongs, getArtistSpotifyApiData, getArtistAlbumsDailyData, getArtistOverallDailyData, getTrackData, getAlbumData, getNewReleases, isUserFavorite, getRecomendations, getArtistStreamingData, getDashboardArtistRankingData, getUserFavourites, getMostStreamedArtists, getMostMonthlyListeners, getMostStreamedSongs, getMostStreamedAlbums, markFavourite, getMostStreamedSongsInSingleDay, getMostStreamedSongsInSingleWeek, getMostStreamedAlbumInSingle, getArtistSocialData } = require('./services');
const port = 4000;
const cors = require('cors');
const app = express();
const mongoose = require('mongoose');



app.use(express.json());
app.use(cors({
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    origin: ['http://localhost:3000', 'https://spotracker.tech', 'https://www.spotracker.tech', 'https://statscrave.com', 'https://www.statscrave.com', 'https://statforfans.netlify.app', 'https://www.statforfans.netlify.app']
  }))

async function connect() {
    try {
        mongoose.connect(process.env.MONGO_URI, {
            dbName: 'prod',
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
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
        return res.status(200).json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/daily/albums/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const artistData = await getArtistAlbumsDailyData(id);
        return res.status(200).json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/daily/overall/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const artistData = await getArtistOverallDailyData(id);
        return res.status(200).json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});


//spotify
app.get('/api/v1/artist/popular/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistMostPopularSongs(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

//spotify
app.get('/api/v1/artist/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistSpotifyApiData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/artist/streams/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistStreamingData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/artist/social/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistSocialData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/track/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getTrackData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/album/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getAlbumData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.get('/api/v1/others/new-releases', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getNewReleases(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.post('/api/v1/user/isFavourite', async (req, res) => {
    try {
        const { id, spotifyId, type } = req.body;
        if (!id || !spotifyId || !type) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await isUserFavorite(type, spotifyId, id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/user/dashboard/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await getDashboardArtistRankingData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.post('/api/v1/user/markFavourite', async (req, res) => {
    try {
        const { id, type, spotifyId, image, name } = req.body;
        if (!id || !spotifyId || !type || !image || !name) {
            return res.status(400).json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await markFavourite(id, type, spotifyId, image, name);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/user/favourites/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await getUserFavourites(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.get('/api/v1/others/getRecomendations', async (req, res) => {
    try {
        const { type } = req.query;
        if (!type) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }
        const data = await getRecomendations(type);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedArtists', async (req, res) => {
    try {
        const { limit } = req.query;
        const data = await getMostStreamedArtists(limit ? parseInt(limit) : 100);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostMonthlyListeners', async (req, res) => {
    try {
        const { limit } = req?.query;
        const data = await getMostMonthlyListeners(limit ? parseInt(limit) : 100);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedSongs', async (req, res) => {
    try {
        const { year } = req?.query;
        const data = await getMostStreamedSongs(year);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedAlbums', async (req, res) => {
    try {
        const data = await getMostStreamedAlbums();
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedSongsInSingleDay', async (req, res) => {
    try {
        const { type } = req?.query;
        const data = await getMostStreamedSongsInSingleDay(type);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedSongsInSingleWeek', async (req, res) => {
    try {
        const data = await getMostStreamedSongsInSingleWeek();
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedAlbumsInSingle', async (req, res) => {
    try {
        const { mode } = req?.query;
        const data = await getMostStreamedAlbumInSingle(mode);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});



app.use('*', (req, res) => {
    res.status(404).json({
        message: 'Not Found',
    });
});


app.listen(port, () => console.log(`App listening on port ${port}!`));