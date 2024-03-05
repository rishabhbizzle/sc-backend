require('dotenv').config();
const express = require('express');
const { getArtistSongsDailyData } = require('./services');
const port = 3000;
const cors = require('cors');
const app = express();



app.use(cors())

app.get('/', (req, res) => {
    res.json({
        message: 'Hello World!',
    });
});

app.get('/api/v1/artistSongs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const artistData = await getArtistSongsDailyData(id);
        console.log(artistData);
        return res.json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
}
);




app.use('*', (req, res) => {
    res.status(404).json({
        message: 'Not Found',
    });
});


app.listen(port, () => console.log(`Example app listening on port ${port}!`));