require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { attachUser } = require('./auth');

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(attachUser);
app.use(require('./routes/auth'));
app.use(require('./routes/courses'));

app.listen(process.env.PORT || 3000, () => console.log('StreamFlix on :' + (process.env.PORT || 3000)));
