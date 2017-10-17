'use strict';

var Transform = require('stream').Transform;
var gutil = require('gulp-util');
var File = gutil.File;
var PluginError = gutil.PluginError;
var rollup = require('rollup');
var path = require('path');
var applySourceMap = require('vinyl-sourcemaps-apply');
var camelCase = require('lodash.camelcase');

var PLUGIN_NAME = 'gulp-better-rollup';

// map object storing rollup cache objects for each input file
var rollupCache = new Map;

function parseBundles(arg) {
	if (typeof arg == 'string')
		return [{format: arg}];
	if (arg instanceof Array)
		return arg;
	return [arg];
}

// transformer class
class GulpRollup extends Transform {

	_transform(file, encoding, cb) {
		// cannot handle empty or unavailable files
		if (file.isNull())
			return cb(null, file);

		// cannot handle streams
		if (file.isStream())
			return cb(new PluginError(PLUGIN_NAME, 'Streaming not supported'));

		var rollupOptions, bundleList;
		if (this.arg2) {
			rollupOptions = Object.assign({}, this.arg1);
			bundleList = parseBundles(this.arg2);
		} else {
			rollupOptions = {};
			bundleList = parseBundles(this.arg1);
		}

		// user should not specify the input file path, but let him if he insists for some reason
		if (rollupOptions.input === undefined)
			// determine input from file filename
			rollupOptions.input = path.relative(file.cwd, file.path);
		else
			// rename file if input is given
			file.path = path.join(file.cwd, rollupOptions.input);

		// caching is enabled by default because of the nature of gulp and the watching/recompilatin
		// but can be disabled by setting 'cache' to false
		if (rollupOptions.cache !== false)
			rollupOptions.cache = rollupCache.get(rollupOptions.input);

		// enable sourcemap is gulp-sourcemaps plugin is enabled
		var createSourceMap = file.sourceMap !== undefined;

		var originalCwd = file.cwd;
		var originalPath = file.path;
		var moduleName = camelCase(path.basename(file.path, path.extname(file.path)));

		function generateAndApplyBundle(bundle, generateOptions, targetFile) {
			generateOptions = extend({}, generateOptions);
			// Sugaring the API by copying convinience objects and properties from rollupOptions
			// to generateOptions (if not defined)
			if (generateOptions.file === undefined)
				generateOptions.file = rollupOptions.file;
			if (generateOptions['exports'] === undefined)
				generateOptions['exports'] = rollupOptions['exports'];
			if (generateOptions.format ===  undefined)
				generateOptions.format = rollupOptions.format;
			// if (generateOptions.moduleId ===  undefined)
			// 	generateOptions.moduleId = rollupOptions.moduleId
			if (generateOptions.globals ===  undefined)
				generateOptions.globals = rollupOptions.globals;
			// Rollup won't bundle iife and umd modules without module name.
			// But it won't say anything either, leaving a space for confusion
			if (generateOptions.name === undefined)
				generateOptions.name = rollupOptions.name || moduleName;
			// if (generateOptions.moduleId === undefined)
			// 	generateOptions.moduleId = generateOptions.moduleName
			generateOptions.sourcemap = createSourceMap;
			// generate bundle according to given or autocompleted options
			// var result = bundle.generate(generateOptions);
			return bundle.generate(generateOptions).then((result)=>{
				if (createSourceMap) {
					result.map.file = path.relative(originalCwd, originalPath);
					result.map.sources = result.map.sources.map(source => path.relative(originalCwd, source));
				}
				// return bundled file as buffer
				targetFile.contents = Buffer.from(result.code);
				// apply sourcemap to output file
				if (createSourceMap)
					applySourceMap(targetFile, result.map);
			});
			// Pass sourcemap content and metadata to gulp-sourcemaps plugin to handle
			// destination (and custom name) was given, possibly multiple output bundles.
			
		}
		var createBundle = (bundle, generateOptions, injectNewFile) => {
			// custom output name might be set
			if (generateOptions.file) {
				// setup filename name from generateOptions.dest
				var newFileName = path.basename(generateOptions.file);
				var newFilePath = path.join(file.base, newFileName);
				if (injectNewFile) {
					// create new file and inject it into stream if needed (in case of multiple outputs)
					var newFile = new File({
						cwd: file.cwd,
						base: file.base,
						path: newFilePath,
						stat: {
							isFile: () => true,
							isDirectory: () => false,
							isBlockDevice: () => false,
							isCharacterDevice: () => false,
							isSymbolicLink: () => false,
							isFIFO: () => false,
							isSocket: () => false
						}
					});
					return generateAndApplyBundle(bundle, generateOptions, newFile).then(()=>{
						this.push(newFile);
					});

				} else {
					// rename original file
					file.path = newFilePath;
					return generateAndApplyBundle(bundle, generateOptions, file);
				}
			} else {
				// file wasnt renamed nor new one was created,
				// apply data and sourcemaps to the original file
				return generateAndApplyBundle(bundle, generateOptions, file);
			}
		};


		// custom rollup can be provided inside the config object
		rollup = rollupOptions.rollup || rollup;
		delete rollupOptions.rollup;
		rollup
			// pass basic options to rollup
			.rollup(rollupOptions)
			// after the magic is done, configure the output format
			.then(bundle => {
				// cache rollup object if caching is enabled
				if (rollupOptions.cache !== false)
					rollupCache.set(rollupOptions.input, bundle);
				// generate ouput according to (each of) given generateOptions
				each(createBundle, bundleList.map((generateOptions, i)=> [bundle, generateOptions, i]))
				// Promise.all(bundleList.map((generateOptions, i) => createBundle(bundle, generateOptions, i)))
				.then(()=>{

					cb(null, file);
				});
				// pass file to gulp and end stream
			}).catch(err => {
				if (rollupOptions.cache !== false)
					rollupCache.delete(rollupOptions.input);
				process.nextTick(() => {
					this.emit('error', new PluginError(PLUGIN_NAME, err));
					cb(null, file);
				});
			});

	}

}

// first argument (rollupOptions) is optional
module.exports = function factory(arg1, arg2) {
	// instantiate the stream class
	var stream = new GulpRollup({objectMode: true});
	// pass in options objects
	stream.arg1 = arg1;
	stream.arg2 = arg2;
	// return the stream instance
	return stream;
};

function each(f,args){
	return args.reduce((p, arg)=>{
		return p.then(f.apply(null, arg));
	}, Promise.resolve());
}

function extend(){
	var sources = [].slice.call(arguments).filter((o)=>(Object(o) === o)), i = 1, l = sources.length;
	if(l < 1){
		return {};
	}
	var target = sources[0];

	while(i < l){
		let s = sources[i];
		for(let k in s){
			if(s.hasOwnProperty(k)){
				target[k] = s[k];
			}
		}
		i += 1;
	}
	return target;
}