import Debounce from 'lodash-es/debounce';
import EventEmitter from 'eventemitter3';
import IsNil from 'lodash-es/isNil';
import IsString from 'lodash-es/isString';
import MapKeys from 'lodash-es/mapKeys';
import Merge from 'lodash-es/merge';

import DocumentObserver from 'neon-extension-framework/document/observer';
import Log from 'neon-extension-source-spotify/core/logger';
import Plugin from 'neon-extension-source-spotify/core/plugin';
import SpotifyApi from 'neon-extension-source-spotify/api';
import {Artist, Album, Track} from 'neon-extension-framework/models/item/music';


export default class PlayerMonitor extends EventEmitter {
    constructor(options) {
        super();

        // Parse options
        this.options = Merge({
            progressInterval: 5000
        }, options);

        // Private attributes
        this._currentMetadata = {};
        this._currentTrack = null;

        this._user = null;
        this._userCountry = null;

        this._observers = null;
        this._progressEmitterInterval = null;

        // Create debounced `create` function
        this.create = Debounce(this._create, 5000);

        // Bind to client events
        SpotifyApi.client.state.on('player_state', this.onPlayerStateChanged.bind(this));
        SpotifyApi.client.state.on('player_state.track.uri', this.onTrackUriChanged.bind(this));
    }

    bind() {
        return Promise.resolve()
            // Fetch user profile
            .then(() => this.fetch())
            // Connect to the events websocket
            .then(() => this.connect())
            // Start observing document for changes
            .then(() => this.observe());
    }

    fetch() {
        return SpotifyApi.me.fetch().then((profile) => {
            this._user = profile;
            this._userCountry = profile.country.toLowerCase();
        }, (err) => {
            Log.error('Unable to fetch current user profile: %s', err.message, err);
            return Promise.reject(err);
        });
    }

    connect() {
        return SpotifyApi.events.connect().catch((err) => {
            Log.error('Unable to connect to the events websocket: %s', err.message, err);
            return Promise.reject(err);
        });
    }

    observe() {
        let trackInfoObserver = DocumentObserver.observe(document, '#main .now-playing .track-info');

        // Create element observers
        return Promise.resolve(this._observers = [
            trackInfoObserver,

            // Observe name changes
            DocumentObserver.observe(trackInfoObserver, '.track-info__name a', { text: true })
                .on('mutation', this._onTrackMutation.bind(this)),

            // Observe artist changes
            DocumentObserver.observe(trackInfoObserver, '.track-info__artists a', { text: true })
                .on('mutation', this._onArtistMutation.bind(this))
        ]);
    }

    // region Event handlers

    onPlayerStateChanged(player) {
        console.log(
            'Player state changed (' +
            `timestamp: ${player['timestamp']}, ` +
            `position_as_of_timestamp: ${player['position_as_of_timestamp']}` +
            ')'
        );

        // Start/Stop Progress Emitter
        if(player['is_playing'] && !player['is_paused']) {
            this._start();
        } else {
            this._pause();
        }
    }

    onTrackUriChanged(uri) {
        // Update state
        let metadata = this._currentMetadata = Merge(this._currentMetadata, {
            track: {
                uri
            }
        });

        // Create track
        console.log(`Track URI changed to ${metadata.track.uri}`);

        this.create();
    }

    _onTrackMutation() {
        let track = document.querySelector('.now-playing .track-info .track-info__name a');

        // Update state
        let metadata = this._currentMetadata = Merge(
            this._currentMetadata,
            this._getTrackMetadata(track)
        );

        // Create track
        console.log(`Track changed to "${metadata.track.title}" (albumUri: ${metadata.album.uri})`);

        this.create();
    }

    _onArtistMutation() {
        let artists = document.querySelector('.now-playing .track-info .track-info__artists');

        // Update state
        let metadata = this._currentMetadata = Merge(
            this._currentMetadata,
            this._getArtistMetadata(artists)
        );

        // Create track
        console.log(`Artist changed to "${metadata.artist.title}" (${metadata.artist.uri})`);

        this.create();
    }

    // endregion

    // region Private methods

    _create() {
        let { artist, album, track } = this._currentMetadata;

        // Try construct track
        let instance = null;

        try {
            instance = this._createTrack(artist, album, track);
        } catch(e) {
            Log.error('Unable to create track: %s', e.message || e);
        }

        // Ensure track exists
        if(IsNil(instance)) {
            Log.warn('Unable to parse track: %o', {
                artist,
                album,
                track
            });

            this._currentTrack = null;
            return;
        }

        // Ensure track has changed
        if(!IsNil(this._currentTrack) && this._currentTrack.matches(instance)) {
            return;
        }

        // Update current identifier
        this._currentTrack = instance;

        // Emit "created" event
        this.emit('created', instance);
    }

    _start() {
        // Ensure progress emitter has been started
        this._startProgressEmitter();
    }

    _pause() {
        // Stop progress emitter
        this._stopProgressEmitter();

        // Emit "paused" event
        this.emit('paused');
    }

    _createTrack(artist, album, track) {
        if(IsNil(track) || IsNil(track.uri) || IsNil(track.title)) {
            return null;
        }

        if(!IsString(track.uri) || track.uri.indexOf('spotify:track:') !== 0) {
            throw new Error(
                'Invalid value provided for the "track.uri" parameter ' +
                '(expected string prefixed with "spotify:track:")'
            );
        }

        if(!IsString(track.title) || track.title.length < 1) {
            throw new Error(
                'Invalid value provided for the "track.title" parameter ' +
                '(expected string)'
            );
        }

        // Create track
        return Track.create(Plugin.id, {
            keys: this._createKeys({
                uri: track.uri
            }),

            // Metadata
            title: track.title,

            // Children
            artist: this._createArtist(artist),
            album: this._createAlbum(album)
        });
    }

    _createAlbum(album) {
        if(IsNil(album) || IsNil(album.uri)) {
            return null;
        }

        if(!IsString(album.uri) || album.uri.indexOf('spotify:album:') !== 0) {
            throw new Error(
                'Invalid value provided for the "album.uri" parameter ' +
                '(expected string prefixed with "spotify:album:")'
            );
        }

        // Create album
        return Album.create(Plugin.id, {
            keys: this._createKeys({
                uri: album.uri
            })
        });
    }

    _createArtist(artist) {
        if(IsNil(artist) || IsNil(artist.uri) || IsNil(artist.title)) {
            return null;
        }

        if(!IsString(artist.uri) || artist.uri.indexOf('spotify:artist:') !== 0) {
            throw new Error(
                'Invalid value provided for the "artist.uri" parameter ' +
                '(expected string prefixed with "spotify:artist:")'
            );
        }

        if(!IsString(artist.title) || artist.title.length < 1) {
            throw new Error(
                'Invalid value provided for the "artist.title" parameter ' +
                '(expected string)'
            );
        }

        // Create artist
        return Artist.create(Plugin.id, {
            keys: this._createKeys({
                uri: artist.uri
            }),

            // Metadata
            title: artist.title
        });
    }

    _createKeys(keys) {
        return {
            ...keys,

            // Include keys with country suffixes
            ...MapKeys(keys, (value, name) => `${name}:${this._userCountry}`)
        };
    }

    _getTrackMetadata(track) {
        let result = {
            track: {
                title: null
            },
            album: {
                uri: null
            }
        };

        if(IsNil(track)) {
            return result;
        }

        // Update result
        result.track.title = track.innerText || null;
        result.album.uri = this._getUri(track.href) || null;

        return result;
    }

    _getArtistMetadata(artists) {
        let result = {
            artist: {
                uri: null,
                title: null
            }
        };

        if(IsNil(artists)) {
            return result;
        }

        // Pick first artist
        let artist = null;

        if(artists.childNodes.length > 0) {
            artist = artists.childNodes[0].querySelector('a');
        } else {
            return result;
        }

        // Update result
        result.artist.uri = this._getUri(artist.href) || null;
        result.artist.title = artist.innerText || null;

        return result;
    }

    _getUri(href) {
        if(IsNil(href)) {
            return null;
        }

        let start;

        // Find protocol
        start = href.indexOf('://');

        if(start < 0) {
            return null;
        }

        // Find path
        start = href.indexOf('/', start + 3);

        if(start < 0) {
            return null;
        }

        // Build URI
        return 'spotify:' + href.substring(start + 1).replace(/\//g, ':');
    }

    _startProgressEmitter() {
        if(!IsNil(this._progressEmitterInterval)) {
            return;
        }

        // Start progress emitter
        this._progressEmitterInterval = setInterval(
            this._emitProgress.bind(this),
            this.options.progressInterval
        );

        console.log('Started progress emitter');
    }

    _stopProgressEmitter() {
        if(IsNil(this._progressEmitterInterval)) {
            return;
        }

        // Stop progress emitter
        clearInterval(this._progressEmitterInterval);

        // Reset state
        this._progressEmitterInterval = null;

        console.log('Stopped progress emitter');
    }

    _emitProgress() {
        if(IsNil(this._currentTrack)) {
            return;
        }

        // Ensure track matches the current metadata (change might be pending)
        let track = this._currentTrack.resolve(Plugin.id);
        let trackUri = track.keys[`uri:${this._userCountry}`];

        if(trackUri !== this._currentMetadata.track.uri) {
            return;
        }

        // Retrieve state
        let paused = SpotifyApi.client.state.get('player_state.is_paused');
        let position = SpotifyApi.client.state.get('player_state.position_as_of_timestamp');
        let timestamp = SpotifyApi.client.state.get('player_state.timestamp');

        // Calculate current time
        let time = position;

        if(!paused) {
            time += Date.now() - timestamp;
        }

        if(time < 0) {
            return;
        }

        // Emit "progress" event
        this.emit('progress', time);
    }

    // endregion
}