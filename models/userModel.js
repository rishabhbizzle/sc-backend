const mongoose = require("mongoose");


const userFavoriteSchema = new mongoose.Schema({
    kindeId: {
        type: String,
        required: [true, "Please provide a user id"],
    },
    type: { 
        type: String,
        enum: ['artist', 'album', 'track'] 
    },
    spotifyId: { 
        type: String,
        required: [true, "Please provide a spotify id"],
    },
    image: { 
        type: String,
    },
    name: { 
        type: String,
        required: [true, "Please provide a name"],
    },
});



const UserFavorite = mongoose.models.userFavorites || mongoose.model("userFavorites", userFavoriteSchema);

module.exports = UserFavorite;