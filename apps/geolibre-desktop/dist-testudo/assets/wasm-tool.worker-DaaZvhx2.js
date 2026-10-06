var Iovec = class Iovec {
	static read_bytes(view, ptr) {
		const iovec = new Iovec();
		iovec.buf = view.getUint32(ptr, true);
		iovec.buf_len = view.getUint32(ptr + 4, true);
		return iovec;
	}
	static read_bytes_array(view, ptr, len) {
		const iovecs = [];
		for (let i = 0; i < len; i++) iovecs.push(Iovec.read_bytes(view, ptr + 8 * i));
		return iovecs;
	}
};
var Ciovec = class Ciovec {
	static read_bytes(view, ptr) {
		const iovec = new Ciovec();
		iovec.buf = view.getUint32(ptr, true);
		iovec.buf_len = view.getUint32(ptr + 4, true);
		return iovec;
	}
	static read_bytes_array(view, ptr, len) {
		const iovecs = [];
		for (let i = 0; i < len; i++) iovecs.push(Ciovec.read_bytes(view, ptr + 8 * i));
		return iovecs;
	}
};
var Dirent = class {
	head_length() {
		return 24;
	}
	name_length() {
		return this.dir_name.byteLength;
	}
	write_head_bytes(view, ptr) {
		view.setBigUint64(ptr, this.d_next, true);
		view.setBigUint64(ptr + 8, this.d_ino, true);
		view.setUint32(ptr + 16, this.dir_name.length, true);
		view.setUint8(ptr + 20, this.d_type);
	}
	write_name_bytes(view8, ptr, buf_len) {
		view8.set(this.dir_name.slice(0, Math.min(this.dir_name.byteLength, buf_len)), ptr);
	}
	constructor(next_cookie, d_ino, name, type) {
		const encoded_name = new TextEncoder().encode(name);
		this.d_next = next_cookie;
		this.d_ino = d_ino;
		this.d_namlen = encoded_name.byteLength;
		this.d_type = type;
		this.dir_name = encoded_name;
	}
};
var Fdstat = class {
	write_bytes(view, ptr) {
		view.setUint8(ptr, this.fs_filetype);
		view.setUint16(ptr + 2, this.fs_flags, true);
		view.setBigUint64(ptr + 8, this.fs_rights_base, true);
		view.setBigUint64(ptr + 16, this.fs_rights_inherited, true);
	}
	constructor(filetype, flags) {
		this.fs_rights_base = 0n;
		this.fs_rights_inherited = 0n;
		this.fs_filetype = filetype;
		this.fs_flags = flags;
	}
};
var Filestat = class {
	write_bytes(view, ptr) {
		view.setBigUint64(ptr, this.dev, true);
		view.setBigUint64(ptr + 8, this.ino, true);
		view.setUint8(ptr + 16, this.filetype);
		view.setBigUint64(ptr + 24, this.nlink, true);
		view.setBigUint64(ptr + 32, this.size, true);
		view.setBigUint64(ptr + 38, this.atim, true);
		view.setBigUint64(ptr + 46, this.mtim, true);
		view.setBigUint64(ptr + 52, this.ctim, true);
	}
	constructor(ino, filetype, size) {
		this.dev = 0n;
		this.nlink = 0n;
		this.atim = 0n;
		this.mtim = 0n;
		this.ctim = 0n;
		this.ino = ino;
		this.filetype = filetype;
		this.size = size;
	}
};
var Subscription = class Subscription {
	static read_bytes(view, ptr) {
		return new Subscription(view.getBigUint64(ptr, true), view.getUint8(ptr + 8), view.getUint32(ptr + 16, true), view.getBigUint64(ptr + 24, true), view.getUint16(ptr + 36, true));
	}
	constructor(userdata, eventtype, clockid, timeout, flags) {
		this.userdata = userdata;
		this.eventtype = eventtype;
		this.clockid = clockid;
		this.timeout = timeout;
		this.flags = flags;
	}
};
var Event = class {
	write_bytes(view, ptr) {
		view.setBigUint64(ptr, this.userdata, true);
		view.setUint16(ptr + 8, this.error, true);
		view.setUint8(ptr + 10, this.eventtype);
	}
	constructor(userdata, error, eventtype) {
		this.userdata = userdata;
		this.error = error;
		this.eventtype = eventtype;
	}
};
var PrestatDir = class {
	write_bytes(view, ptr) {
		view.setUint32(ptr, this.pr_name.byteLength, true);
	}
	constructor(name) {
		this.pr_name = new TextEncoder().encode(name);
	}
};
var Prestat = class Prestat {
	static dir(name) {
		const prestat = new Prestat();
		prestat.tag = 0;
		prestat.inner = new PrestatDir(name);
		return prestat;
	}
	write_bytes(view, ptr) {
		view.setUint32(ptr, this.tag, true);
		this.inner.write_bytes(view, ptr + 4);
	}
};
//#endregion
//#region ../../node_modules/@bjorn3/browser_wasi_shim/dist/debug.js
let Debug = class Debug {
	enable(enabled) {
		this.log = createLogger(enabled === void 0 ? true : enabled, this.prefix);
	}
	get enabled() {
		return this.isEnabled;
	}
	constructor(isEnabled) {
		this.isEnabled = isEnabled;
		this.prefix = "wasi:";
		this.enable(isEnabled);
	}
};
function createLogger(enabled, prefix) {
	if (enabled) return console.log.bind(console, "%c%s", "color: #265BA0", prefix);
	else return () => {};
}
const debug = new Debug(false);
//#endregion
//#region ../../node_modules/@bjorn3/browser_wasi_shim/dist/wasi.js
var WASIProcExit = class extends Error {
	constructor(code) {
		super("exit with exit code " + code);
		this.code = code;
	}
};
let WASI = class WASI {
	start(instance) {
		this.inst = instance;
		try {
			instance.exports._start();
			return 0;
		} catch (e) {
			if (e instanceof WASIProcExit) return e.code;
			else throw e;
		}
	}
	initialize(instance) {
		this.inst = instance;
		if (instance.exports._initialize) instance.exports._initialize();
	}
	constructor(args, env, fds, options = {}) {
		this.args = [];
		this.env = [];
		this.fds = [];
		debug.enable(options.debug);
		this.args = args;
		this.env = env;
		this.fds = fds;
		const self = this;
		this.wasiImport = {
			args_sizes_get(argc, argv_buf_size) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				buffer.setUint32(argc, self.args.length, true);
				let buf_size = 0;
				for (const arg of self.args) buf_size += arg.length + 1;
				buffer.setUint32(argv_buf_size, buf_size, true);
				debug.log(buffer.getUint32(argc, true), buffer.getUint32(argv_buf_size, true));
				return 0;
			},
			args_get(argv, argv_buf) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				const orig_argv_buf = argv_buf;
				for (let i = 0; i < self.args.length; i++) {
					buffer.setUint32(argv, argv_buf, true);
					argv += 4;
					const arg = new TextEncoder().encode(self.args[i]);
					buffer8.set(arg, argv_buf);
					buffer.setUint8(argv_buf + arg.length, 0);
					argv_buf += arg.length + 1;
				}
				if (debug.enabled) debug.log(new TextDecoder("utf-8").decode(buffer8.slice(orig_argv_buf, argv_buf)));
				return 0;
			},
			environ_sizes_get(environ_count, environ_size) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				buffer.setUint32(environ_count, self.env.length, true);
				let buf_size = 0;
				for (const environ of self.env) buf_size += new TextEncoder().encode(environ).length + 1;
				buffer.setUint32(environ_size, buf_size, true);
				debug.log(buffer.getUint32(environ_count, true), buffer.getUint32(environ_size, true));
				return 0;
			},
			environ_get(environ, environ_buf) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				const orig_environ_buf = environ_buf;
				for (let i = 0; i < self.env.length; i++) {
					buffer.setUint32(environ, environ_buf, true);
					environ += 4;
					const e = new TextEncoder().encode(self.env[i]);
					buffer8.set(e, environ_buf);
					buffer.setUint8(environ_buf + e.length, 0);
					environ_buf += e.length + 1;
				}
				if (debug.enabled) debug.log(new TextDecoder("utf-8").decode(buffer8.slice(orig_environ_buf, environ_buf)));
				return 0;
			},
			clock_res_get(id, res_ptr) {
				let resolutionValue;
				switch (id) {
					case 1:
						resolutionValue = 5000n;
						break;
					case 0:
						resolutionValue = 1000000n;
						break;
					default: return 52;
				}
				new DataView(self.inst.exports.memory.buffer).setBigUint64(res_ptr, resolutionValue, true);
				return 0;
			},
			clock_time_get(id, precision, time) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				if (id === 0) buffer.setBigUint64(time, BigInt((/* @__PURE__ */ new Date()).getTime()) * 1000000n, true);
				else if (id == 1) {
					let monotonic_time;
					try {
						monotonic_time = BigInt(Math.round(performance.now() * 1e6));
					} catch (e) {
						monotonic_time = 0n;
					}
					buffer.setBigUint64(time, monotonic_time, true);
				} else buffer.setBigUint64(time, 0n, true);
				return 0;
			},
			fd_advise(fd, offset, len, advice) {
				if (self.fds[fd] != void 0) return 0;
				else return 8;
			},
			fd_allocate(fd, offset, len) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_allocate(offset, len);
				else return 8;
			},
			fd_close(fd) {
				if (self.fds[fd] != void 0) {
					const ret = self.fds[fd].fd_close();
					self.fds[fd] = void 0;
					return ret;
				} else return 8;
			},
			fd_datasync(fd) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_sync();
				else return 8;
			},
			fd_fdstat_get(fd, fdstat_ptr) {
				if (self.fds[fd] != void 0) {
					const { ret, fdstat } = self.fds[fd].fd_fdstat_get();
					if (fdstat != null) fdstat.write_bytes(new DataView(self.inst.exports.memory.buffer), fdstat_ptr);
					return ret;
				} else return 8;
			},
			fd_fdstat_set_flags(fd, flags) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_fdstat_set_flags(flags);
				else return 8;
			},
			fd_fdstat_set_rights(fd, fs_rights_base, fs_rights_inheriting) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_fdstat_set_rights(fs_rights_base, fs_rights_inheriting);
				else return 8;
			},
			fd_filestat_get(fd, filestat_ptr) {
				if (self.fds[fd] != void 0) {
					const { ret, filestat } = self.fds[fd].fd_filestat_get();
					if (filestat != null) filestat.write_bytes(new DataView(self.inst.exports.memory.buffer), filestat_ptr);
					return ret;
				} else return 8;
			},
			fd_filestat_set_size(fd, size) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_filestat_set_size(size);
				else return 8;
			},
			fd_filestat_set_times(fd, atim, mtim, fst_flags) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_filestat_set_times(atim, mtim, fst_flags);
				else return 8;
			},
			fd_pread(fd, iovs_ptr, iovs_len, offset, nread_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const iovecs = Iovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
					let nread = 0;
					for (const iovec of iovecs) {
						const { ret, data } = self.fds[fd].fd_pread(iovec.buf_len, offset);
						if (ret != 0) {
							buffer.setUint32(nread_ptr, nread, true);
							return ret;
						}
						buffer8.set(data, iovec.buf);
						nread += data.length;
						offset += BigInt(data.length);
						if (data.length != iovec.buf_len) break;
					}
					buffer.setUint32(nread_ptr, nread, true);
					return 0;
				} else return 8;
			},
			fd_prestat_get(fd, buf_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const { ret, prestat } = self.fds[fd].fd_prestat_get();
					if (prestat != null) prestat.write_bytes(buffer, buf_ptr);
					return ret;
				} else return 8;
			},
			fd_prestat_dir_name(fd, path_ptr, path_len) {
				if (self.fds[fd] != void 0) {
					const { ret, prestat } = self.fds[fd].fd_prestat_get();
					if (prestat == null) return ret;
					const prestat_dir_name = prestat.inner.pr_name;
					new Uint8Array(self.inst.exports.memory.buffer).set(prestat_dir_name.slice(0, path_len), path_ptr);
					return prestat_dir_name.byteLength > path_len ? 37 : 0;
				} else return 8;
			},
			fd_pwrite(fd, iovs_ptr, iovs_len, offset, nwritten_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
					let nwritten = 0;
					for (const iovec of iovecs) {
						const data = buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len);
						const { ret, nwritten: nwritten_part } = self.fds[fd].fd_pwrite(data, offset);
						if (ret != 0) {
							buffer.setUint32(nwritten_ptr, nwritten, true);
							return ret;
						}
						nwritten += nwritten_part;
						offset += BigInt(nwritten_part);
						if (nwritten_part != data.byteLength) break;
					}
					buffer.setUint32(nwritten_ptr, nwritten, true);
					return 0;
				} else return 8;
			},
			fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const iovecs = Iovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
					let nread = 0;
					for (const iovec of iovecs) {
						const { ret, data } = self.fds[fd].fd_read(iovec.buf_len);
						if (ret != 0) {
							buffer.setUint32(nread_ptr, nread, true);
							return ret;
						}
						buffer8.set(data, iovec.buf);
						nread += data.length;
						if (data.length != iovec.buf_len) break;
					}
					buffer.setUint32(nread_ptr, nread, true);
					return 0;
				} else return 8;
			},
			fd_readdir(fd, buf, buf_len, cookie, bufused_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					let bufused = 0;
					while (true) {
						const { ret, dirent } = self.fds[fd].fd_readdir_single(cookie);
						if (ret != 0) {
							buffer.setUint32(bufused_ptr, bufused, true);
							return ret;
						}
						if (dirent == null) break;
						if (buf_len - bufused < dirent.head_length()) {
							bufused = buf_len;
							break;
						}
						const head_bytes = new ArrayBuffer(dirent.head_length());
						dirent.write_head_bytes(new DataView(head_bytes), 0);
						buffer8.set(new Uint8Array(head_bytes).slice(0, Math.min(head_bytes.byteLength, buf_len - bufused)), buf);
						buf += dirent.head_length();
						bufused += dirent.head_length();
						if (buf_len - bufused < dirent.name_length()) {
							bufused = buf_len;
							break;
						}
						dirent.write_name_bytes(buffer8, buf, buf_len - bufused);
						buf += dirent.name_length();
						bufused += dirent.name_length();
						cookie = dirent.d_next;
					}
					buffer.setUint32(bufused_ptr, bufused, true);
					return 0;
				} else return 8;
			},
			fd_renumber(fd, to) {
				if (self.fds[fd] != void 0 && self.fds[to] != void 0) {
					const ret = self.fds[to].fd_close();
					if (ret != 0) return ret;
					self.fds[to] = self.fds[fd];
					self.fds[fd] = void 0;
					return 0;
				} else return 8;
			},
			fd_seek(fd, offset, whence, offset_out_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const { ret, offset: offset_out } = self.fds[fd].fd_seek(offset, whence);
					buffer.setBigInt64(offset_out_ptr, offset_out, true);
					return ret;
				} else return 8;
			},
			fd_sync(fd) {
				if (self.fds[fd] != void 0) return self.fds[fd].fd_sync();
				else return 8;
			},
			fd_tell(fd, offset_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const { ret, offset } = self.fds[fd].fd_tell();
					buffer.setBigUint64(offset_ptr, offset, true);
					return ret;
				} else return 8;
			},
			fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
					let nwritten = 0;
					for (const iovec of iovecs) {
						const data = buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len);
						const { ret, nwritten: nwritten_part } = self.fds[fd].fd_write(data);
						if (ret != 0) {
							buffer.setUint32(nwritten_ptr, nwritten, true);
							return ret;
						}
						nwritten += nwritten_part;
						if (nwritten_part != data.byteLength) break;
					}
					buffer.setUint32(nwritten_ptr, nwritten, true);
					return 0;
				} else return 8;
			},
			path_create_directory(fd, path_ptr, path_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					return self.fds[fd].path_create_directory(path);
				} else return 8;
			},
			path_filestat_get(fd, flags, path_ptr, path_len, filestat_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					const { ret, filestat } = self.fds[fd].path_filestat_get(flags, path);
					if (filestat != null) filestat.write_bytes(buffer, filestat_ptr);
					return ret;
				} else return 8;
			},
			path_filestat_set_times(fd, flags, path_ptr, path_len, atim, mtim, fst_flags) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					return self.fds[fd].path_filestat_set_times(flags, path, atim, mtim, fst_flags);
				} else return 8;
			},
			path_link(old_fd, old_flags, old_path_ptr, old_path_len, new_fd, new_path_ptr, new_path_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[old_fd] != void 0 && self.fds[new_fd] != void 0) {
					const old_path = new TextDecoder("utf-8").decode(buffer8.slice(old_path_ptr, old_path_ptr + old_path_len));
					const new_path = new TextDecoder("utf-8").decode(buffer8.slice(new_path_ptr, new_path_ptr + new_path_len));
					const { ret, inode_obj } = self.fds[old_fd].path_lookup(old_path, old_flags);
					if (inode_obj == null) return ret;
					return self.fds[new_fd].path_link(new_path, inode_obj, false);
				} else return 8;
			},
			path_open(fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fd_flags, opened_fd_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					debug.log(path);
					const { ret, fd_obj } = self.fds[fd].path_open(dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fd_flags);
					if (ret != 0) return ret;
					self.fds.push(fd_obj);
					const opened_fd = self.fds.length - 1;
					buffer.setUint32(opened_fd_ptr, opened_fd, true);
					return 0;
				} else return 8;
			},
			path_readlink(fd, path_ptr, path_len, buf_ptr, buf_len, nread_ptr) {
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					debug.log(path);
					const { ret, data } = self.fds[fd].path_readlink(path);
					if (data != null) {
						const data_buf = new TextEncoder().encode(data);
						if (data_buf.length > buf_len) {
							buffer.setUint32(nread_ptr, 0, true);
							return 8;
						}
						buffer8.set(data_buf, buf_ptr);
						buffer.setUint32(nread_ptr, data_buf.length, true);
					}
					return ret;
				} else return 8;
			},
			path_remove_directory(fd, path_ptr, path_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					return self.fds[fd].path_remove_directory(path);
				} else return 8;
			},
			path_rename(fd, old_path_ptr, old_path_len, new_fd, new_path_ptr, new_path_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0 && self.fds[new_fd] != void 0) {
					const old_path = new TextDecoder("utf-8").decode(buffer8.slice(old_path_ptr, old_path_ptr + old_path_len));
					const new_path = new TextDecoder("utf-8").decode(buffer8.slice(new_path_ptr, new_path_ptr + new_path_len));
					let { ret, inode_obj } = self.fds[fd].path_unlink(old_path);
					if (inode_obj == null) return ret;
					ret = self.fds[new_fd].path_link(new_path, inode_obj, true);
					if (ret != 0) {
						if (self.fds[fd].path_link(old_path, inode_obj, true) != 0) throw "path_link should always return success when relinking an inode back to the original place";
					}
					return ret;
				} else return 8;
			},
			path_symlink(old_path_ptr, old_path_len, fd, new_path_ptr, new_path_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					new TextDecoder("utf-8").decode(buffer8.slice(old_path_ptr, old_path_ptr + old_path_len));
					new TextDecoder("utf-8").decode(buffer8.slice(new_path_ptr, new_path_ptr + new_path_len));
					return 58;
				} else return 8;
			},
			path_unlink_file(fd, path_ptr, path_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
				if (self.fds[fd] != void 0) {
					const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
					return self.fds[fd].path_unlink_file(path);
				} else return 8;
			},
			poll_oneoff(in_ptr, out_ptr, nsubscriptions) {
				if (nsubscriptions === 0) return 28;
				if (nsubscriptions > 1) {
					debug.log("poll_oneoff: only a single subscription is supported");
					return 58;
				}
				const buffer = new DataView(self.inst.exports.memory.buffer);
				const s = Subscription.read_bytes(buffer, in_ptr);
				const eventtype = s.eventtype;
				const clockid = s.clockid;
				const timeout = s.timeout;
				if (eventtype !== 0) {
					debug.log("poll_oneoff: only clock subscriptions are supported");
					return 58;
				}
				let getNow = void 0;
				if (clockid === 1) getNow = () => BigInt(Math.round(performance.now() * 1e6));
				else if (clockid === 0) getNow = () => BigInt((/* @__PURE__ */ new Date()).getTime()) * 1000000n;
				else return 28;
				const endTime = (s.flags & 1) !== 0 ? timeout : getNow() + timeout;
				while (endTime > getNow());
				new Event(s.userdata, 0, eventtype).write_bytes(buffer, out_ptr);
				return 0;
			},
			proc_exit(exit_code) {
				throw new WASIProcExit(exit_code);
			},
			proc_raise(sig) {
				throw "raised signal " + sig;
			},
			sched_yield() {},
			random_get(buf, buf_len) {
				const buffer8 = new Uint8Array(self.inst.exports.memory.buffer).subarray(buf, buf + buf_len);
				if ("crypto" in globalThis && (typeof SharedArrayBuffer === "undefined" || !(self.inst.exports.memory.buffer instanceof SharedArrayBuffer))) for (let i = 0; i < buf_len; i += 65536) crypto.getRandomValues(buffer8.subarray(i, i + 65536));
				else for (let i = 0; i < buf_len; i++) buffer8[i] = Math.random() * 256 | 0;
			},
			sock_recv(fd, ri_data, ri_flags) {
				throw "sockets not supported";
			},
			sock_send(fd, si_data, si_flags) {
				throw "sockets not supported";
			},
			sock_shutdown(fd, how) {
				throw "sockets not supported";
			},
			sock_accept(fd, flags) {
				throw "sockets not supported";
			}
		};
	}
};
//#endregion
//#region ../../node_modules/@bjorn3/browser_wasi_shim/dist/fd.js
var Fd = class {
	fd_allocate(offset, len) {
		return 58;
	}
	fd_close() {
		return 0;
	}
	fd_fdstat_get() {
		return {
			ret: 58,
			fdstat: null
		};
	}
	fd_fdstat_set_flags(flags) {
		return 58;
	}
	fd_fdstat_set_rights(fs_rights_base, fs_rights_inheriting) {
		return 58;
	}
	fd_filestat_get() {
		return {
			ret: 58,
			filestat: null
		};
	}
	fd_filestat_set_size(size) {
		return 58;
	}
	fd_filestat_set_times(atim, mtim, fst_flags) {
		return 58;
	}
	fd_pread(size, offset) {
		return {
			ret: 58,
			data: /* @__PURE__ */ new Uint8Array()
		};
	}
	fd_prestat_get() {
		return {
			ret: 58,
			prestat: null
		};
	}
	fd_pwrite(data, offset) {
		return {
			ret: 58,
			nwritten: 0
		};
	}
	fd_read(size) {
		return {
			ret: 58,
			data: /* @__PURE__ */ new Uint8Array()
		};
	}
	fd_readdir_single(cookie) {
		return {
			ret: 58,
			dirent: null
		};
	}
	fd_seek(offset, whence) {
		return {
			ret: 58,
			offset: 0n
		};
	}
	fd_sync() {
		return 0;
	}
	fd_tell() {
		return {
			ret: 58,
			offset: 0n
		};
	}
	fd_write(data) {
		return {
			ret: 58,
			nwritten: 0
		};
	}
	path_create_directory(path) {
		return 58;
	}
	path_filestat_get(flags, path) {
		return {
			ret: 58,
			filestat: null
		};
	}
	path_filestat_set_times(flags, path, atim, mtim, fst_flags) {
		return 58;
	}
	path_link(path, inode, allow_dir) {
		return 58;
	}
	path_unlink(path) {
		return {
			ret: 58,
			inode_obj: null
		};
	}
	path_lookup(path, dirflags) {
		return {
			ret: 58,
			inode_obj: null
		};
	}
	path_open(dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fd_flags) {
		return {
			ret: 54,
			fd_obj: null
		};
	}
	path_readlink(path) {
		return {
			ret: 58,
			data: null
		};
	}
	path_remove_directory(path) {
		return 58;
	}
	path_rename(old_path, new_fd, new_path) {
		return 58;
	}
	path_unlink_file(path) {
		return 58;
	}
};
var Inode = class Inode {
	static issue_ino() {
		return Inode.next_ino++;
	}
	static root_ino() {
		return 0n;
	}
	constructor() {
		this.ino = Inode.issue_ino();
	}
};
Inode.next_ino = 1n;
//#endregion
//#region ../../node_modules/@bjorn3/browser_wasi_shim/dist/fs_mem.js
var OpenFile = class extends Fd {
	fd_allocate(offset, len) {
		if (this.file.size > offset + len) {} else {
			const new_data = new Uint8Array(Number(offset + len));
			new_data.set(this.file.data, 0);
			this.file.data = new_data;
		}
		return 0;
	}
	fd_fdstat_get() {
		return {
			ret: 0,
			fdstat: new Fdstat(4, 0)
		};
	}
	fd_filestat_set_size(size) {
		if (this.file.size > size) this.file.data = new Uint8Array(this.file.data.buffer.slice(0, Number(size)));
		else {
			const new_data = new Uint8Array(Number(size));
			new_data.set(this.file.data, 0);
			this.file.data = new_data;
		}
		return 0;
	}
	fd_read(size) {
		const slice = this.file.data.slice(Number(this.file_pos), Number(this.file_pos + BigInt(size)));
		this.file_pos += BigInt(slice.length);
		return {
			ret: 0,
			data: slice
		};
	}
	fd_pread(size, offset) {
		return {
			ret: 0,
			data: this.file.data.slice(Number(offset), Number(offset + BigInt(size)))
		};
	}
	fd_seek(offset, whence) {
		let calculated_offset;
		switch (whence) {
			case 0:
				calculated_offset = offset;
				break;
			case 1:
				calculated_offset = this.file_pos + offset;
				break;
			case 2:
				calculated_offset = BigInt(this.file.data.byteLength) + offset;
				break;
			default: return {
				ret: 28,
				offset: 0n
			};
		}
		if (calculated_offset < 0) return {
			ret: 28,
			offset: 0n
		};
		this.file_pos = calculated_offset;
		return {
			ret: 0,
			offset: this.file_pos
		};
	}
	fd_tell() {
		return {
			ret: 0,
			offset: this.file_pos
		};
	}
	fd_write(data) {
		if (this.file.readonly) return {
			ret: 8,
			nwritten: 0
		};
		if (this.file_pos + BigInt(data.byteLength) > this.file.size) {
			const old = this.file.data;
			this.file.data = new Uint8Array(Number(this.file_pos + BigInt(data.byteLength)));
			this.file.data.set(old);
		}
		this.file.data.set(data, Number(this.file_pos));
		this.file_pos += BigInt(data.byteLength);
		return {
			ret: 0,
			nwritten: data.byteLength
		};
	}
	fd_pwrite(data, offset) {
		if (this.file.readonly) return {
			ret: 8,
			nwritten: 0
		};
		if (offset + BigInt(data.byteLength) > this.file.size) {
			const old = this.file.data;
			this.file.data = new Uint8Array(Number(offset + BigInt(data.byteLength)));
			this.file.data.set(old);
		}
		this.file.data.set(data, Number(offset));
		return {
			ret: 0,
			nwritten: data.byteLength
		};
	}
	fd_filestat_get() {
		return {
			ret: 0,
			filestat: this.file.stat()
		};
	}
	constructor(file) {
		super();
		this.file_pos = 0n;
		this.file = file;
	}
};
var OpenDirectory = class extends Fd {
	fd_seek(offset, whence) {
		return {
			ret: 8,
			offset: 0n
		};
	}
	fd_tell() {
		return {
			ret: 8,
			offset: 0n
		};
	}
	fd_allocate(offset, len) {
		return 8;
	}
	fd_fdstat_get() {
		return {
			ret: 0,
			fdstat: new Fdstat(3, 0)
		};
	}
	fd_readdir_single(cookie) {
		if (debug.enabled) {
			debug.log("readdir_single", cookie);
			debug.log(cookie, this.dir.contents.keys());
		}
		if (cookie == 0n) return {
			ret: 0,
			dirent: new Dirent(1n, this.dir.ino, ".", 3)
		};
		else if (cookie == 1n) return {
			ret: 0,
			dirent: new Dirent(2n, this.dir.parent_ino(), "..", 3)
		};
		if (cookie >= BigInt(this.dir.contents.size) + 2n) return {
			ret: 0,
			dirent: null
		};
		const [name, entry] = Array.from(this.dir.contents.entries())[Number(cookie - 2n)];
		return {
			ret: 0,
			dirent: new Dirent(cookie + 1n, entry.ino, name, entry.stat().filetype)
		};
	}
	path_filestat_get(flags, path_str) {
		const { ret: path_err, path } = Path.from(path_str);
		if (path == null) return {
			ret: path_err,
			filestat: null
		};
		const { ret, entry } = this.dir.get_entry_for_path(path);
		if (entry == null) return {
			ret,
			filestat: null
		};
		return {
			ret: 0,
			filestat: entry.stat()
		};
	}
	path_lookup(path_str, dirflags) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return {
			ret: path_ret,
			inode_obj: null
		};
		const { ret, entry } = this.dir.get_entry_for_path(path);
		if (entry == null) return {
			ret,
			inode_obj: null
		};
		return {
			ret: 0,
			inode_obj: entry
		};
	}
	path_open(dirflags, path_str, oflags, fs_rights_base, fs_rights_inheriting, fd_flags) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return {
			ret: path_ret,
			fd_obj: null
		};
		let { ret, entry } = this.dir.get_entry_for_path(path);
		if (entry == null) {
			if (ret != 44) return {
				ret,
				fd_obj: null
			};
			if ((oflags & 1) == 1) {
				const { ret, entry: new_entry } = this.dir.create_entry_for_path(path_str, (oflags & 2) == 2);
				if (new_entry == null) return {
					ret,
					fd_obj: null
				};
				entry = new_entry;
			} else return {
				ret: 44,
				fd_obj: null
			};
		} else if ((oflags & 4) == 4) return {
			ret: 20,
			fd_obj: null
		};
		if ((oflags & 2) == 2 && entry.stat().filetype !== 3) return {
			ret: 54,
			fd_obj: null
		};
		return entry.path_open(oflags, fs_rights_base, fd_flags);
	}
	path_create_directory(path) {
		return this.path_open(0, path, 3, 0n, 0n, 0).ret;
	}
	path_link(path_str, inode, allow_dir) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return path_ret;
		if (path.is_dir) return 44;
		const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, true);
		if (parent_entry == null || filename == null) return parent_ret;
		if (entry != null) {
			const source_is_dir = inode.stat().filetype == 3;
			const target_is_dir = entry.stat().filetype == 3;
			if (source_is_dir && target_is_dir) {
				if (allow_dir && entry instanceof Directory) {
					if (entry.contents.size == 0) {} else return 55;
				} else return 20;
			} else if (source_is_dir && !target_is_dir) return 54;
			else if (!source_is_dir && target_is_dir) return 31;
			else if (inode.stat().filetype == 4 && entry.stat().filetype == 4) {} else return 20;
		}
		if (!allow_dir && inode.stat().filetype == 3) return 63;
		parent_entry.contents.set(filename, inode);
		return 0;
	}
	path_unlink(path_str) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return {
			ret: path_ret,
			inode_obj: null
		};
		const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, true);
		if (parent_entry == null || filename == null) return {
			ret: parent_ret,
			inode_obj: null
		};
		if (entry == null) return {
			ret: 44,
			inode_obj: null
		};
		parent_entry.contents.delete(filename);
		return {
			ret: 0,
			inode_obj: entry
		};
	}
	path_unlink_file(path_str) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return path_ret;
		const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, false);
		if (parent_entry == null || filename == null || entry == null) return parent_ret;
		if (entry.stat().filetype === 3) return 31;
		parent_entry.contents.delete(filename);
		return 0;
	}
	path_remove_directory(path_str) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return path_ret;
		const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, false);
		if (parent_entry == null || filename == null || entry == null) return parent_ret;
		if (!(entry instanceof Directory) || entry.stat().filetype !== 3) return 54;
		if (entry.contents.size !== 0) return 55;
		if (!parent_entry.contents.delete(filename)) return 44;
		return 0;
	}
	fd_filestat_get() {
		return {
			ret: 0,
			filestat: this.dir.stat()
		};
	}
	fd_filestat_set_size(size) {
		return 8;
	}
	fd_read(size) {
		return {
			ret: 8,
			data: /* @__PURE__ */ new Uint8Array()
		};
	}
	fd_pread(size, offset) {
		return {
			ret: 8,
			data: /* @__PURE__ */ new Uint8Array()
		};
	}
	fd_write(data) {
		return {
			ret: 8,
			nwritten: 0
		};
	}
	fd_pwrite(data, offset) {
		return {
			ret: 8,
			nwritten: 0
		};
	}
	constructor(dir) {
		super();
		this.dir = dir;
	}
};
var PreopenDirectory = class extends OpenDirectory {
	fd_prestat_get() {
		return {
			ret: 0,
			prestat: Prestat.dir(this.prestat_name)
		};
	}
	constructor(name, contents) {
		super(new Directory(contents));
		this.prestat_name = name;
	}
};
var File = class extends Inode {
	path_open(oflags, fs_rights_base, fd_flags) {
		if (this.readonly && (fs_rights_base & BigInt(64)) == BigInt(64)) return {
			ret: 63,
			fd_obj: null
		};
		if ((oflags & 8) == 8) {
			if (this.readonly) return {
				ret: 63,
				fd_obj: null
			};
			this.data = new Uint8Array([]);
		}
		const file = new OpenFile(this);
		if (fd_flags & 1) file.fd_seek(0n, 2);
		return {
			ret: 0,
			fd_obj: file
		};
	}
	get size() {
		return BigInt(this.data.byteLength);
	}
	stat() {
		return new Filestat(this.ino, 4, this.size);
	}
	constructor(data, options) {
		super();
		this.data = new Uint8Array(data);
		this.readonly = !!options?.readonly;
	}
};
let Path = class Path {
	static from(path) {
		const self = new Path();
		self.is_dir = path.endsWith("/");
		if (path.startsWith("/")) return {
			ret: 76,
			path: null
		};
		if (path.includes("\0")) return {
			ret: 28,
			path: null
		};
		for (const component of path.split("/")) {
			if (component === "" || component === ".") continue;
			if (component === "..") {
				if (self.parts.pop() == void 0) return {
					ret: 76,
					path: null
				};
				continue;
			}
			self.parts.push(component);
		}
		return {
			ret: 0,
			path: self
		};
	}
	to_path_string() {
		let s = this.parts.join("/");
		if (this.is_dir) s += "/";
		return s;
	}
	constructor() {
		this.parts = [];
		this.is_dir = false;
	}
};
var Directory = class Directory extends Inode {
	parent_ino() {
		if (this.parent == null) return Inode.root_ino();
		return this.parent.ino;
	}
	path_open(oflags, fs_rights_base, fd_flags) {
		return {
			ret: 0,
			fd_obj: new OpenDirectory(this)
		};
	}
	stat() {
		return new Filestat(this.ino, 3, 0n);
	}
	get_entry_for_path(path) {
		let entry = this;
		for (const component of path.parts) {
			if (!(entry instanceof Directory)) return {
				ret: 54,
				entry: null
			};
			const child = entry.contents.get(component);
			if (child !== void 0) entry = child;
			else {
				debug.log(component);
				return {
					ret: 44,
					entry: null
				};
			}
		}
		if (path.is_dir) {
			if (entry.stat().filetype != 3) return {
				ret: 54,
				entry: null
			};
		}
		return {
			ret: 0,
			entry
		};
	}
	get_parent_dir_and_entry_for_path(path, allow_undefined) {
		const filename = path.parts.pop();
		if (filename === void 0) return {
			ret: 28,
			parent_entry: null,
			filename: null,
			entry: null
		};
		const { ret: entry_ret, entry: parent_entry } = this.get_entry_for_path(path);
		if (parent_entry == null) return {
			ret: entry_ret,
			parent_entry: null,
			filename: null,
			entry: null
		};
		if (!(parent_entry instanceof Directory)) return {
			ret: 54,
			parent_entry: null,
			filename: null,
			entry: null
		};
		const entry = parent_entry.contents.get(filename);
		if (entry === void 0) {
			if (!allow_undefined) return {
				ret: 44,
				parent_entry: null,
				filename: null,
				entry: null
			};
			else return {
				ret: 0,
				parent_entry,
				filename,
				entry: null
			};
		}
		if (path.is_dir) {
			if (entry.stat().filetype != 3) return {
				ret: 54,
				parent_entry: null,
				filename: null,
				entry: null
			};
		}
		return {
			ret: 0,
			parent_entry,
			filename,
			entry
		};
	}
	create_entry_for_path(path_str, is_dir) {
		const { ret: path_ret, path } = Path.from(path_str);
		if (path == null) return {
			ret: path_ret,
			entry: null
		};
		let { ret: parent_ret, parent_entry, filename, entry } = this.get_parent_dir_and_entry_for_path(path, true);
		if (parent_entry == null || filename == null) return {
			ret: parent_ret,
			entry: null
		};
		if (entry != null) return {
			ret: 20,
			entry: null
		};
		debug.log("create", path);
		let new_child;
		if (!is_dir) new_child = new File(/* @__PURE__ */ new ArrayBuffer(0));
		else new_child = new Directory(/* @__PURE__ */ new Map());
		parent_entry.contents.set(filename, new_child);
		entry = new_child;
		return {
			ret: 0,
			entry
		};
	}
	constructor(contents) {
		super();
		this.parent = null;
		if (contents instanceof Array) this.contents = new Map(contents);
		else this.contents = contents;
		for (const entry of this.contents.values()) if (entry instanceof Directory) entry.parent = this;
	}
};
var ConsoleStdout = class ConsoleStdout extends Fd {
	fd_filestat_get() {
		return {
			ret: 0,
			filestat: new Filestat(this.ino, 2, BigInt(0))
		};
	}
	fd_fdstat_get() {
		const fdstat = new Fdstat(2, 0);
		fdstat.fs_rights_base = BigInt(64);
		return {
			ret: 0,
			fdstat
		};
	}
	fd_write(data) {
		this.write(data);
		return {
			ret: 0,
			nwritten: data.byteLength
		};
	}
	static lineBuffered(write) {
		const dec = new TextDecoder("utf-8", { fatal: false });
		let line_buf = "";
		return new ConsoleStdout((buffer) => {
			line_buf += dec.decode(buffer, { stream: true });
			const lines = line_buf.split("\n");
			for (const [i, line] of lines.entries()) if (i < lines.length - 1) write(line);
			else line_buf = line;
		});
	}
	constructor(write) {
		super();
		this.ino = Inode.issue_ino();
		this.write = write;
	}
};
//#endregion
//#region ../../node_modules/geolibre-wasm/geolibre_wasm.js
/**
* Builder for encoding a Cloud Optimized GeoTIFF (tiled, with overviews and
* GDAL ghost metadata) to bytes. A COG is also a valid plain GeoTIFF.
*
* Configure with the `set_*` methods, then call one of `write_*` with the
* pixel data to get a `Uint8Array` of the encoded file.
*/
var CogBuilder = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		CogBuilderFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_cogbuilder_free(ptr, 0);
	}
	/**
	* New builder for a `width` x `height` raster with `bands` bands.
	* @param {number} width
	* @param {number} height
	* @param {number} bands
	*/
	constructor(width, height, bands) {
		const ret = wasm.cogbuilder_new(width, height, bands);
		this.__wbg_ptr = ret;
		CogBuilderFinalization.register(this, this.__wbg_ptr, this);
		return this;
	}
	/**
	* Force BigTIFF (64-bit offsets) for very large outputs.
	* @param {boolean} on
	*/
	set_bigtiff(on) {
		wasm.cogbuilder_set_bigtiff(this.__wbg_ptr, on);
	}
	/**
	* Compression: `none`, `lzw`, `deflate`, `packbits`, `webp`, `jpeg`, `jpegxl`.
	* @param {string} name
	*/
	set_compression(name) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogbuilder_set_compression(retptr, this.__wbg_ptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			if (getDataViewMemory0().getInt32(retptr + 4, true)) throw takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Set the EPSG code (1..=65535).
	* @param {number} epsg
	*/
	set_epsg(epsg) {
		wasm.cogbuilder_set_epsg(this.__wbg_ptr, epsg);
	}
	/**
	* Set the full affine geo-transform:
	* `[x_origin, pixel_width, row_rotation, y_origin, col_rotation, pixel_height]`.
	* @param {Float64Array} gt
	*/
	set_geo_transform(gt) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArrayF64ToWasm0(gt, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogbuilder_set_geo_transform(retptr, this.__wbg_ptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			if (getDataViewMemory0().getInt32(retptr + 4, true)) throw takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Set the no-data sentinel value.
	* @param {number} v
	*/
	set_nodata(v) {
		wasm.cogbuilder_set_nodata(this.__wbg_ptr, v);
	}
	/**
	* Convenience: north-up geo-transform from upper-left origin and pixel size.
	* @param {number} x_min
	* @param {number} y_max
	* @param {number} pixel_size
	*/
	set_origin(x_min, y_max, pixel_size) {
		wasm.cogbuilder_set_origin(this.__wbg_ptr, x_min, y_max, pixel_size);
	}
	/**
	* Explicit overview decimation factors (e.g. `[2,4,8]`); empty disables overviews.
	* @param {Uint32Array} levels
	*/
	set_overview_levels(levels) {
		const ptr0 = passArray32ToWasm0(levels, wasm.__wbindgen_export2);
		const len0 = WASM_VECTOR_LEN;
		wasm.cogbuilder_set_overview_levels(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* Internal tile size in pixels (default 512).
	* @param {number} px
	*/
	set_tile_size(px) {
		wasm.cogbuilder_set_tile_size(this.__wbg_ptr, px);
	}
	/**
	* Encode `f32` pixel data to a COG. `Uint8Array`.
	* @param {Float32Array} data
	* @returns {Uint8Array}
	*/
	write_f32(data) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogbuilder_write_f32(retptr, this.__wbg_ptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Encode `f64` pixel data to a COG. `Uint8Array`.
	* @param {Float64Array} data
	* @returns {Uint8Array}
	*/
	write_f64(data) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogbuilder_write_f64(retptr, this.__wbg_ptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Encode `u8` pixel data to a COG. `Uint8Array`.
	* @param {Uint8Array} data
	* @returns {Uint8Array}
	*/
	write_u8(data) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogbuilder_write_u8(retptr, this.__wbg_ptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
};
if (Symbol.dispose) CogBuilder.prototype[Symbol.dispose] = CogBuilder.prototype.free;
/**
* Range-request reader for a (tiled) Cloud Optimized GeoTIFF.
*
* The wasm module does no network I/O itself; this class parses the header and
* tells the JS host exactly which byte ranges to fetch, then decodes the tiles
* the host fetches. Typical flow:
*
* 1. Range-fetch the first chunk of the file (e.g. 0..1 MiB) and
*    `new CogStream(headerBytes)`. If it throws "need more header bytes", fetch
*    a larger prefix and retry.
* 2. Pick a level (0 = full res, higher = overviews) and a pixel window.
* 3. `tiles_for_window(level, x, y, w, h)` returns the tiles and their byte
*    ranges; range-fetch each, then `decode_tile_f64(level, bytes)`.
*/
var CogStream = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		CogStreamFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_cogstream_free(ptr, 0);
	}
	/**
	* Reproject a bbox from `bbox_epsg` into this COG's dataset CRS.
	*
	* The COG projection string is preferred over its EPSG tag when available,
	* because some user-defined projected GeoTIFFs expose only their geographic
	* base EPSG code.
	* @param {number} bbox_epsg
	* @param {Float64Array} bbox
	* @returns {Float64Array}
	*/
	bbox_to_dataset_crs(bbox_epsg, bbox) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArrayF64ToWasm0(bbox, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogstream_bbox_to_dataset_crs(retptr, this.__wbg_ptr, bbox_epsg, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Bounding box `[min_x, min_y, max_x, max_y]` in the dataset CRS, or empty.
	* @returns {Float64Array}
	*/
	bounding_box() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_bounding_box(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Bounds `[min_lon, min_lat, max_lon, max_lat]` in WGS84 degrees, or empty.
	* @returns {Float64Array}
	*/
	bounds_lonlat() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_bounds_lonlat(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Image center `[x, y]` in the dataset CRS, or empty.
	* @returns {Float64Array}
	*/
	center() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_center(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Image center `[lon, lat]` in WGS84 degrees, or empty if not convertible.
	* @returns {Float64Array}
	*/
	center_lonlat() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_center_lonlat(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Decode one tile's fetched (compressed) bytes into an `f64` `Float64Array`,
	* pixel-interleaved, length `tile_width * tile_height * bands`. Edge tiles
	* come back full-size; clip to the image/window on the JS side.
	* @param {number} level
	* @param {Uint8Array} tile_bytes
	* @returns {Float64Array}
	*/
	decode_tile_f64(level, tile_bytes) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArray8ToWasm0(tile_bytes, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogstream_decode_tile_f64(retptr, this.__wbg_ptr, level, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* EPSG code of the full-resolution level, if any.
	* @returns {number | undefined}
	*/
	get epsg() {
		const ret = wasm.cogstream_epsg(this.__wbg_ptr);
		return ret === Number.MAX_SAFE_INTEGER ? void 0 : ret;
	}
	/**
	* Level-0 geo-transform `[x_origin, pixel_width, row_rot, y_origin, col_rot,
	* pixel_height]`, or empty if not georeferenced.
	* @returns {Float64Array}
	*/
	geo_transform() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_geo_transform(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* True when the COG CRS is represented by a user-defined projection string.
	* @returns {boolean}
	*/
	get has_projection_string() {
		return wasm.cogstream_has_projection_string(this.__wbg_ptr) !== 0;
	}
	/**
	* JSON array describing every level: `[{level,width,height,tile_width,
	* tile_height,tiles_x,tiles_y,bands,bits_per_sample,sample_format,compression}]`.
	* @returns {string}
	*/
	levels_json() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_levels_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
		}
	}
	/**
	* Parse a COG's tile layout from front-of-file header bytes.
	* @param {Uint8Array} header_bytes
	*/
	constructor(header_bytes) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArray8ToWasm0(header_bytes, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogstream_new(retptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			this.__wbg_ptr = r0;
			CogStreamFinalization.register(this, this.__wbg_ptr, this);
			return this;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* No-data sentinel, if declared.
	* @returns {number | undefined}
	*/
	get nodata() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_nodata(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r2 = getDataViewMemory0().getFloat64(retptr + 8, true);
			return r0 === 0 ? void 0 : r2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Number of resolution levels (1 + overview count).
	* @returns {number}
	*/
	get num_levels() {
		return wasm.cogstream_num_levels(this.__wbg_ptr) >>> 0;
	}
	/**
	* Reproject x,y coordinate pairs from this COG's dataset CRS to an EPSG CRS.
	* @param {number} dst_epsg
	* @param {Float64Array} xy
	* @returns {Float64Array}
	*/
	points_from_dataset_crs(dst_epsg, xy) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogstream_points_from_dataset_crs(retptr, this.__wbg_ptr, dst_epsg, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Reproject x,y coordinate pairs from an EPSG CRS into this COG's dataset CRS.
	* @param {number} src_epsg
	* @param {Float64Array} xy
	* @returns {Float64Array}
	*/
	points_to_dataset_crs(src_epsg, xy) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.cogstream_points_to_dataset_crs(retptr, this.__wbg_ptr, src_epsg, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v2 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* `[offset, length]` byte range of the tile at `(col, row)` on `level`.
	* @param {number} level
	* @param {number} col
	* @param {number} row
	* @returns {Float64Array}
	*/
	tile_range(level, col, row) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_tile_range(retptr, this.__wbg_ptr, level, col, row);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Tiles covering a pixel window on `level`, as a JSON array of
	* `{col,row,offset,length}`. Fetch each byte range, then `decode_tile_f64`.
	* @param {number} level
	* @param {number} x
	* @param {number} y
	* @param {number} w
	* @param {number} h
	* @returns {string}
	*/
	tiles_for_window(level, x, y, w, h) {
		let deferred2_0;
		let deferred2_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.cogstream_tiles_for_window(retptr, this.__wbg_ptr, level, x, y, w, h);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			var r3 = getDataViewMemory0().getInt32(retptr + 12, true);
			var ptr1 = r0;
			var len1 = r1;
			if (r3) {
				ptr1 = 0;
				len1 = 0;
				throw takeObject(r2);
			}
			deferred2_0 = ptr1;
			deferred2_1 = len1;
			return getStringFromWasm0(ptr1, len1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred2_0, deferred2_1, 1);
		}
	}
};
if (Symbol.dispose) CogStream.prototype[Symbol.dispose] = CogStream.prototype.free;
/**
* A parsed GeoTIFF held in memory. Construct once, then call the accessor and
* `read_*` methods many times without re-parsing the file.
*/
var GeoTiffReader = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		GeoTiffReaderFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_geotiffreader_free(ptr, 0);
	}
	/**
	* @returns {number}
	*/
	get bands() {
		return wasm.geotiffreader_bands(this.__wbg_ptr) >>> 0;
	}
	/**
	* @returns {number}
	*/
	get bits_per_sample() {
		return wasm.geotiffreader_bits_per_sample(this.__wbg_ptr);
	}
	/**
	* Bounding box as `[min_x, min_y, max_x, max_y]`, or empty if not georeferenced.
	* @returns {Float64Array}
	*/
	bounding_box() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_bounding_box(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Bounds `[min_lon, min_lat, max_lon, max_lat]` in WGS84 degrees, or empty
	* if not convertible.
	* @returns {Float64Array}
	*/
	bounds_lonlat() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_bounds_lonlat(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Image center `[x, y]` in the dataset CRS, or empty if not georeferenced.
	* @returns {Float64Array}
	*/
	center() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_center(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Image center `[lon, lat]` in WGS84 degrees, or empty if not georeferenced
	* or the CRS is not convertible.
	* @returns {Float64Array}
	*/
	center_lonlat() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_center_lonlat(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* @returns {string}
	*/
	get compression() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_compression(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
		}
	}
	/**
	* EPSG code, or `undefined` if the file is not georeferenced by EPSG.
	* @returns {number | undefined}
	*/
	get epsg() {
		const ret = wasm.geotiffreader_epsg(this.__wbg_ptr);
		return ret === Number.MAX_SAFE_INTEGER ? void 0 : ret;
	}
	/**
	* Affine geo-transform as `[x_origin, pixel_width, row_rotation,
	* y_origin, col_rotation, pixel_height]`, or an empty array if absent.
	* @returns {Float64Array}
	*/
	geo_transform() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_geo_transform(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* @returns {number}
	*/
	get height() {
		return wasm.geotiffreader_height(this.__wbg_ptr) >>> 0;
	}
	/**
	* Full metadata as a JSON string (same shape as [`geotiff_info`]).
	* @returns {string}
	*/
	info_json() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_info_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
		}
	}
	/**
	* @returns {boolean}
	*/
	get is_bigtiff() {
		return wasm.geotiffreader_is_bigtiff(this.__wbg_ptr) !== 0;
	}
	/**
	* Parse a GeoTIFF / BigTIFF / COG from raw bytes.
	* @param {Uint8Array} data
	*/
	constructor(data) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.geotiffreader_new(retptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			this.__wbg_ptr = r0;
			GeoTiffReaderFinalization.register(this, this.__wbg_ptr, this);
			return this;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* No-data sentinel, or `undefined` if none is declared.
	* @returns {number | undefined}
	*/
	get nodata() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_nodata(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r2 = getDataViewMemory0().getFloat64(retptr + 8, true);
			return r0 === 0 ? void 0 : r2;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Read every band as `f64`, interleaved per pixel (`band0,band1,...`).
	* @returns {Float64Array}
	*/
	read_all_f64() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_all_f64(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Read a band's raw, undecoded-to-native bytes. `Uint8Array`.
	* @param {number} band
	* @returns {Uint8Array}
	*/
	read_band_bytes(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_bytes(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `f32` band. `Float32Array`.
	* @param {number} band
	* @returns {Float32Array}
	*/
	read_band_f32(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_f32(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayF32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Read a band as `f64`, converting from any on-disk type. `Float64Array`.
	* @param {number} band
	* @returns {Float64Array}
	*/
	read_band_f64(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_f64(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `i16` band. `Int16Array`.
	* @param {number} band
	* @returns {Int16Array}
	*/
	read_band_i16(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_i16(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayI16FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 2, 2);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `i32` band. `Int32Array`.
	* @param {number} band
	* @returns {Int32Array}
	*/
	read_band_i32(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_i32(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayI32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `i8` band. `Int8Array`.
	* @param {number} band
	* @returns {Int8Array}
	*/
	read_band_i8(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_i8(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayI8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `u16` band. `Uint16Array`.
	* @param {number} band
	* @returns {Uint16Array}
	*/
	read_band_u16(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_u16(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU16FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 2, 2);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `u32` band. `Uint32Array`.
	* @param {number} band
	* @returns {Uint32Array}
	*/
	read_band_u32(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_u32(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Native `u8` band. `Uint8Array`.
	* @param {number} band
	* @returns {Uint8Array}
	*/
	read_band_u8(band) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_read_band_u8(retptr, this.__wbg_ptr, band);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* @returns {string}
	*/
	get sample_format() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_sample_format(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
		}
	}
	/**
	* Band-0 statistics as a JSON string (same shape as [`geotiff_stats`]).
	* @returns {string}
	*/
	stats_json() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_stats_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
		}
	}
	/**
	* GDAL value transform as `[scale, offset]` (physical = raw*scale+offset),
	* or empty if none. Apply to `read_*` outputs to get physical values.
	* @returns {Float64Array}
	*/
	value_transform() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.geotiffreader_value_transform(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* @returns {number}
	*/
	get width() {
		return wasm.geotiffreader_width(this.__wbg_ptr) >>> 0;
	}
};
if (Symbol.dispose) GeoTiffReader.prototype[Symbol.dispose] = GeoTiffReader.prototype.free;
var PmtilesExtractor = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		PmtilesExtractorFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_pmtilesextractor_free(ptr, 0);
	}
	/**
	* True once every needed range has been fed; `finish()` is then valid.
	* @returns {boolean}
	*/
	get done() {
		return wasm.pmtilesextractor_done(this.__wbg_ptr) !== 0;
	}
	/**
	* Hand back the bytes of one `wanted_json()` range, identified by its
	* offset. Ranges may be fed in any order.
	* @param {number} offset
	* @param {Uint8Array} bytes
	*/
	feed(offset, bytes) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.pmtilesextractor_feed(retptr, this.__wbg_ptr, offset, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			if (getDataViewMemory0().getInt32(retptr + 4, true)) throw takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Assemble the extracted archive. Consumes the extractor's buffers; the
	* returned `Uint8Array` is a complete `.pmtiles` file.
	* @returns {Uint8Array}
	*/
	finish() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_finish(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Source archive header as JSON (`{}` until the first feed): zooms,
	* bounds, tile type/compression, tile counts. Lets a UI validate the
	* request and describe the source before committing to the download.
	* @returns {string}
	*/
	header_json() {
		let deferred2_0;
		let deferred2_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_header_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			var r3 = getDataViewMemory0().getInt32(retptr + 12, true);
			var ptr1 = r0;
			var len1 = r1;
			if (r3) {
				ptr1 = 0;
				len1 = 0;
				throw takeObject(r2);
			}
			deferred2_0 = ptr1;
			deferred2_1 = len1;
			return getStringFromWasm0(ptr1, len1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred2_0, deferred2_1, 1);
		}
	}
	/**
	* Plan an extraction of `min_zoom..=max_zoom` tiles intersecting the
	* WGS84 bbox. Zooms are clamped to what the source archive contains once
	* its header arrives; `min_zoom` 0 keeps the basemap usable zoomed out.
	* @param {number} min_lon
	* @param {number} min_lat
	* @param {number} max_lon
	* @param {number} max_lat
	* @param {number} min_zoom
	* @param {number} max_zoom
	*/
	constructor(min_lon, min_lat, max_lon, max_lat, min_zoom, max_zoom) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_new(retptr, min_lon, min_lat, max_lon, max_lat, min_zoom, max_zoom);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			this.__wbg_ptr = r0;
			PmtilesExtractorFinalization.register(this, this.__wbg_ptr, this);
			return this;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Progress as JSON: `{"phase":"header|directories|data|done",
	* "tiles_selected":n,"blobs_total":n,"data_bytes_total":n,
	* "data_bytes_received":n,"estimated_output_bytes":n}`.
	* @returns {string}
	*/
	progress_json() {
		let deferred2_0;
		let deferred2_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_progress_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			var r3 = getDataViewMemory0().getInt32(retptr + 12, true);
			var ptr1 = r0;
			var len1 = r1;
			if (r3) {
				ptr1 = 0;
				len1 = 0;
				throw takeObject(r2);
			}
			deferred2_0 = ptr1;
			deferred2_1 = len1;
			return getStringFromWasm0(ptr1, len1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred2_0, deferred2_1, 1);
		}
	}
	/**
	* Coalesce tile-data requests whose byte gap is at most this (default
	* 65,536). Larger values trade overfetch for fewer HTTP round-trips.
	* @param {number} max_gap
	*/
	set_max_range_gap(max_gap) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_set_max_range_gap(retptr, this.__wbg_ptr, max_gap);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			if (getDataViewMemory0().getInt32(retptr + 4, true)) throw takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Cap on addressed tiles (default 2,000,000). Raise for huge desktop
	* extracts; lower to fail fast in memory-constrained embeds.
	* @param {number} max_tiles
	*/
	set_max_tiles(max_tiles) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_set_max_tiles(retptr, this.__wbg_ptr, max_tiles);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			if (getDataViewMemory0().getInt32(retptr + 4, true)) throw takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Outstanding byte ranges the host should fetch, as a JSON array of
	* `{"offset":n,"length":n}`. Empty array when nothing is outstanding.
	* @returns {string}
	*/
	wanted_json() {
		let deferred2_0;
		let deferred2_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.pmtilesextractor_wanted_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			var r3 = getDataViewMemory0().getInt32(retptr + 12, true);
			var ptr1 = r0;
			var len1 = r1;
			if (r3) {
				ptr1 = 0;
				len1 = 0;
				throw takeObject(r2);
			}
			deferred2_0 = ptr1;
			deferred2_1 = len1;
			return getStringFromWasm0(ptr1, len1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred2_0, deferred2_1, 1);
		}
	}
};
if (Symbol.dispose) PmtilesExtractor.prototype[Symbol.dispose] = PmtilesExtractor.prototype.free;
/**
* A layer's geometry and attributes as flat typed arrays.
*
* Produced by [`vector_to_binary`]. Every accessor copies into a fresh
* JavaScript typed array, so read each one once and keep the reference.
*/
var VectorBinary = class VectorBinary {
	static __wrap(ptr) {
		const obj = Object.create(VectorBinary.prototype);
		obj.__wbg_ptr = ptr;
		VectorBinaryFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		VectorBinaryFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_vectorbinary_free(ptr, 0);
	}
	/**
	* Bounds as `[min_x, min_y, max_x, max_y]`, or an empty array when the
	* layer has no geometry.
	* @returns {Float64Array}
	*/
	get bbox() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_bbox(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* EPSG code of the layer's CRS, if it declares one.
	* @returns {number | undefined}
	*/
	get epsg() {
		const ret = wasm.vectorbinary_epsg(this.__wbg_ptr);
		return ret === Number.MAX_SAFE_INTEGER ? void 0 : ret;
	}
	/**
	* Number of features in the source layer.
	* @returns {number}
	*/
	get feature_count() {
		return wasm.vectorbinary_feature_count(this.__wbg_ptr) >>> 0;
	}
	/**
	* Number of attribute fields.
	* @returns {number}
	*/
	get field_count() {
		return wasm.vectorbinary_field_count(this.__wbg_ptr) >>> 0;
	}
	/**
	* Per line vertex: index into the line feature list.
	* @returns {Uint32Array}
	*/
	line_feature_ids() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_line_feature_ids(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per line feature: its index in the whole layer.
	* @returns {Uint32Array}
	*/
	line_feature_index() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_line_feature_index(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per line vertex: index into the whole layer.
	* @returns {Uint32Array}
	*/
	line_global_feature_ids() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_line_global_feature_ids(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Vertex offsets delimiting each path; ends at the total vertex count.
	* @returns {Uint32Array}
	*/
	line_path_indices() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_line_path_indices(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Line positions, `position_size` values per vertex.
	* @returns {Float64Array}
	*/
	line_positions() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_line_positions(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Field `index` as one `f64` per feature: integers and floats as-is,
	* booleans as 1/0, everything else (including nulls) as `NaN`.
	* @param {number} index
	* @returns {Float64Array}
	*/
	numeric_column(index) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_numeric_column(retptr, this.__wbg_ptr, index);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per point vertex: index into the point feature list.
	* @returns {Uint32Array}
	*/
	point_feature_ids() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_point_feature_ids(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per point feature: its index in the whole layer.
	* @returns {Uint32Array}
	*/
	point_feature_index() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_point_feature_index(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per point vertex: index into the whole layer.
	* @returns {Uint32Array}
	*/
	point_global_feature_ids() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_point_global_feature_ids(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Point positions, `position_size` values per vertex.
	* @returns {Float64Array}
	*/
	point_positions() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_point_positions(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per polygon vertex: index into the polygon feature list.
	* @returns {Uint32Array}
	*/
	polygon_feature_ids() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_polygon_feature_ids(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per polygon feature: its index in the whole layer.
	* @returns {Uint32Array}
	*/
	polygon_feature_index() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_polygon_feature_index(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Per polygon vertex: index into the whole layer.
	* @returns {Uint32Array}
	*/
	polygon_global_feature_ids() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_polygon_global_feature_ids(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Vertex offsets delimiting each whole polygon.
	* @returns {Uint32Array}
	*/
	polygon_indices() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_polygon_indices(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Polygon positions, `position_size` values per vertex.
	* @returns {Float64Array}
	*/
	polygon_positions() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_polygon_positions(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayF64FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 8, 8);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Vertex offsets delimiting each ring (exterior and holes alike).
	* @returns {Uint32Array}
	*/
	polygon_primitive_polygon_indices() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_polygon_primitive_polygon_indices(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Values per vertex in every `positions` array: 2, or 3 when any geometry
	* carries a Z coordinate.
	* @returns {number}
	*/
	get position_size() {
		return wasm.vectorbinary_position_size(this.__wbg_ptr) >>> 0;
	}
	/**
	* Attribute schema as JSON: `[{"name":...,"type":...}, ...]`. Field values
	* themselves come from [`Self::numeric_column`] / [`Self::text_column`].
	* @returns {string}
	*/
	get schema_json() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_schema_json(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
		}
	}
	/**
	* Field `index` as UTF-8 bytes for every feature, concatenated. Split it
	* with [`Self::text_column_offsets`]. Non-text values are stringified;
	* nulls are empty.
	* @param {number} index
	* @returns {Uint8Array}
	*/
	text_column(index) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_text_column(retptr, this.__wbg_ptr, index);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 1, 1);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Byte offsets into [`Self::text_column`], `feature_count + 1` entries.
	* @param {number} index
	* @returns {Uint32Array}
	*/
	text_column_offsets(index) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.vectorbinary_text_column_offsets(retptr, this.__wbg_ptr, index);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
			if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
			var v1 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_export(r0, r1 * 4, 4);
			return v1;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
};
if (Symbol.dispose) VectorBinary.prototype[Symbol.dispose] = VectorBinary.prototype.free;
/**
* Reproject a bbox between two EPSG CRSs.
*
* Input and output order is `[min_x, min_y, max_x, max_y]`. The bbox edges are
* densified so projected extrema that fall along an edge are preserved better
* than a corner-only transform.
* @param {number} src_epsg
* @param {number} dst_epsg
* @param {Float64Array} bbox
* @returns {Float64Array}
*/
function transform_bbox_epsg(src_epsg, dst_epsg, bbox) {
	try {
		const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
		const ptr0 = passArrayF64ToWasm0(bbox, wasm.__wbindgen_export2);
		const len0 = WASM_VECTOR_LEN;
		wasm.transform_bbox_epsg(retptr, src_epsg, dst_epsg, ptr0, len0);
		var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
		var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
		var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
		if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
		var v2 = getArrayF64FromWasm0(r0, r1).slice();
		wasm.__wbindgen_export(r0, r1 * 8, 8);
		return v2;
	} finally {
		wasm.__wbindgen_add_to_stack_pointer(16);
	}
}
/**
* Reproject x,y coordinate pairs between two EPSG CRSs.
* @param {number} src_epsg
* @param {number} dst_epsg
* @param {Float64Array} xy
* @returns {Float64Array}
*/
function transform_points_epsg(src_epsg, dst_epsg, xy) {
	try {
		const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
		const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_export2);
		const len0 = WASM_VECTOR_LEN;
		wasm.transform_points_epsg(retptr, src_epsg, dst_epsg, ptr0, len0);
		var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
		var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
		var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
		if (getDataViewMemory0().getInt32(retptr + 12, true)) throw takeObject(r2);
		var v2 = getArrayF64FromWasm0(r0, r1).slice();
		wasm.__wbindgen_export(r0, r1 * 8, 8);
		return v2;
	} finally {
		wasm.__wbindgen_add_to_stack_pointer(16);
	}
}
function __wbg_get_imports() {
	return {
		__proto__: null,
		"./geolibre_wasm_bg.js": {
			__proto__: null,
			__wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
				throw new Error(getStringFromWasm0(arg0, arg1));
			},
			__wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
				let deferred0_0;
				let deferred0_1;
				try {
					deferred0_0 = arg0;
					deferred0_1 = arg1;
					console.error(getStringFromWasm0(arg0, arg1));
				} finally {
					wasm.__wbindgen_export(deferred0_0, deferred0_1, 1);
				}
			},
			__wbg_new_227d7c05414eb861: function() {
				return addHeapObject(/* @__PURE__ */ new Error());
			},
			__wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
				const ret = getObject(arg1).stack;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbindgen_cast_0000000000000001: function(arg0, arg1) {
				return addHeapObject(getStringFromWasm0(arg0, arg1));
			},
			__wbindgen_object_drop_ref: function(arg0) {
				takeObject(arg0);
			}
		}
	};
}
const CogBuilderFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_cogbuilder_free(ptr, 1));
const CogStreamFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_cogstream_free(ptr, 1));
const GeoTiffReaderFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_geotiffreader_free(ptr, 1));
const PmtilesExtractorFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_pmtilesextractor_free(ptr, 1));
const VectorBinaryFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_vectorbinary_free(ptr, 1));
function addHeapObject(obj) {
	if (heap_next === heap.length) heap.push(heap.length + 1);
	const idx = heap_next;
	heap_next = heap[idx];
	heap[idx] = obj;
	return idx;
}
function dropObject(idx) {
	if (idx < 1028) return;
	heap[idx] = heap_next;
	heap_next = idx;
}
function getArrayF32FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayF64FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}
function getArrayI16FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getInt16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}
function getArrayI32FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayI8FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
function getArrayU16FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}
function getArrayU32FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU8FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
	if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
	return cachedDataViewMemory0;
}
let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
	if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
	return cachedFloat32ArrayMemory0;
}
let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
	if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
	return cachedFloat64ArrayMemory0;
}
let cachedInt16ArrayMemory0 = null;
function getInt16ArrayMemory0() {
	if (cachedInt16ArrayMemory0 === null || cachedInt16ArrayMemory0.byteLength === 0) cachedInt16ArrayMemory0 = new Int16Array(wasm.memory.buffer);
	return cachedInt16ArrayMemory0;
}
let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
	if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
	return cachedInt32ArrayMemory0;
}
let cachedInt8ArrayMemory0 = null;
function getInt8ArrayMemory0() {
	if (cachedInt8ArrayMemory0 === null || cachedInt8ArrayMemory0.byteLength === 0) cachedInt8ArrayMemory0 = new Int8Array(wasm.memory.buffer);
	return cachedInt8ArrayMemory0;
}
function getStringFromWasm0(ptr, len) {
	return decodeText(ptr >>> 0, len);
}
let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
	if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
	return cachedUint16ArrayMemory0;
}
let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
	if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
	return cachedUint32ArrayMemory0;
}
let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
	if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
	return cachedUint8ArrayMemory0;
}
function getObject(idx) {
	return heap[idx];
}
let heap = new Array(1024).fill(void 0);
heap.push(void 0, null, true, false);
let heap_next = heap.length;
function passArray32ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 4, 4) >>> 0;
	getUint32ArrayMemory0().set(arg, ptr / 4);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}
function passArray8ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 1, 1) >>> 0;
	getUint8ArrayMemory0().set(arg, ptr / 1);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}
function passArrayF32ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 4, 4) >>> 0;
	getFloat32ArrayMemory0().set(arg, ptr / 4);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}
function passArrayF64ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 8, 8) >>> 0;
	getFloat64ArrayMemory0().set(arg, ptr / 8);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}
function passStringToWasm0(arg, malloc, realloc) {
	if (realloc === void 0) {
		const buf = cachedTextEncoder.encode(arg);
		const ptr = malloc(buf.length, 1) >>> 0;
		getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
		WASM_VECTOR_LEN = buf.length;
		return ptr;
	}
	let len = arg.length;
	let ptr = malloc(len, 1) >>> 0;
	const mem = getUint8ArrayMemory0();
	let offset = 0;
	for (; offset < len; offset++) {
		const code = arg.charCodeAt(offset);
		if (code > 127) break;
		mem[ptr + offset] = code;
	}
	if (offset !== len) {
		if (offset !== 0) arg = arg.slice(offset);
		ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
		const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
		const ret = cachedTextEncoder.encodeInto(arg, view);
		offset += ret.written;
		ptr = realloc(ptr, len, offset, 1) >>> 0;
	}
	WASM_VECTOR_LEN = offset;
	return ptr;
}
function takeObject(idx) {
	const ret = getObject(idx);
	dropObject(idx);
	return ret;
}
let cachedTextDecoder = new TextDecoder("utf-8", {
	ignoreBOM: true,
	fatal: true
});
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
	numBytesDecoded += len;
	if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
		cachedTextDecoder = new TextDecoder("utf-8", {
			ignoreBOM: true,
			fatal: true
		});
		cachedTextDecoder.decode();
		numBytesDecoded = len;
	}
	return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
const cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) cachedTextEncoder.encodeInto = function(arg, view) {
	const buf = cachedTextEncoder.encode(arg);
	view.set(buf);
	return {
		read: arg.length,
		written: buf.length
	};
};
let WASM_VECTOR_LEN = 0;
let wasm;
function __wbg_finalize_init(instance, module) {
	wasm = instance.exports;
	cachedDataViewMemory0 = null;
	cachedFloat32ArrayMemory0 = null;
	cachedFloat64ArrayMemory0 = null;
	cachedInt16ArrayMemory0 = null;
	cachedInt32ArrayMemory0 = null;
	cachedInt8ArrayMemory0 = null;
	cachedUint16ArrayMemory0 = null;
	cachedUint32ArrayMemory0 = null;
	cachedUint8ArrayMemory0 = null;
	wasm.__wbindgen_start();
	return wasm;
}
async function __wbg_load(module, imports) {
	if (typeof Response === "function" && module instanceof Response) {
		if (typeof WebAssembly.instantiateStreaming === "function") try {
			return await WebAssembly.instantiateStreaming(module, imports);
		} catch (e) {
			if (module.ok && expectedResponseType(module.type) && module.headers.get("Content-Type") !== "application/wasm") console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
			else throw e;
		}
		const bytes = await module.arrayBuffer();
		return await WebAssembly.instantiate(bytes, imports);
	} else {
		const instance = await WebAssembly.instantiate(module, imports);
		if (instance instanceof WebAssembly.Instance) return {
			instance,
			module
		};
		else return instance;
	}
	function expectedResponseType(type) {
		switch (type) {
			case "basic":
			case "cors":
			case "default": return true;
		}
		return false;
	}
}
async function __wbg_init(module_or_path) {
	if (wasm !== void 0) return wasm;
	if (module_or_path !== void 0) {
		if (Object.getPrototypeOf(module_or_path) === Object.prototype) ({module_or_path} = module_or_path);
		else console.warn("using deprecated parameters for the initialization function; pass a single object instead");
	}
	if (module_or_path === void 0) module_or_path = new URL("/geolibre-native/assets/geolibre_wasm_bg-CGd2Ktbq.wasm", "" + import.meta.url);
	const imports = __wbg_get_imports();
	if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) module_or_path = fetch(module_or_path);
	const { instance, module } = await __wbg_load(await module_or_path, imports);
	return __wbg_finalize_init(instance, module);
}
//#endregion
//#region ../../node_modules/geolibre-wasm/tools.mjs
let _module = null;
let _libraryReady = null;
const COG_SUBSET_TOOL_ID = "extract_cog_subset";
const WMS_SUBSET_TOOL_ID = "extract_wms_subset";
const XYZ_SUBSET_TOOL_ID = "extract_xyz_tile_subset";
const PMTILES_EXTRACT_TOOL_ID = "pmtiles_extract";
const OSM_DOWNLOAD_TOOL_ID = "download_osm_vector";
/**
* Compile the WASI tool runner once. In browsers/bundlers it loads the bundled
* `geolibre-cli.wasm` relative to this module. In Node (no fetch of file URLs),
* pass the wasm bytes or a URL/Response explicitly.
* @param {URL|Response|BufferSource|string} [source]
* @returns {Promise<WebAssembly.Module>}
*/
async function initTools(source) {
	if (_module) return _module;
	if (!source) source = new URL("/geolibre-native/assets/geolibre-cli-kMtL_iVH.wasm", "" + import.meta.url);
	if (source instanceof Uint8Array || source instanceof ArrayBuffer) _module = await WebAssembly.compile(source);
	else if (source instanceof Response) _module = await WebAssembly.compileStreaming(source);
	else _module = await WebAssembly.compileStreaming(fetch(source));
	return _module;
}
async function initLibrary() {
	if (!_libraryReady) _libraryReady = __wbg_init();
	return _libraryReady;
}
async function materializeInput(value) {
	if (typeof value === "string") {
		if (!/^https?:\/\//i.test(value)) throw new Error(`input string must be an http(s) URL, got: ${value}`);
		const resp = await fetch(value, { headers: { "User-Agent": "Mozilla/5.0 (geolibre-wasm)" } });
		return new Uint8Array(await resp.arrayBuffer());
	}
	return new Uint8Array(value);
}
function describeTrap(argv, err, stdout) {
	const tool = argv[0] ?? "tool";
	const tail = stdout.map((s) => s.trimEnd()).filter(Boolean).slice(-12);
	const detail = tail.length ? `\n${tail.join("\n")}` : "";
	return `${tool} crashed: ${err.message}${detail}`;
}
async function exec(argv, inputFiles) {
	const mod = await initTools();
	const inNames = new Set(Object.keys(inputFiles));
	const entries = await Promise.all(Object.entries(inputFiles).map(async ([k, v]) => [k, new File(await materializeInput(v))]));
	const work = new PreopenDirectory("/work", new Map(entries));
	const stdout = [];
	const fds = [
		new OpenFile(new File(/* @__PURE__ */ new Uint8Array())),
		ConsoleStdout.lineBuffered((s) => stdout.push(s)),
		ConsoleStdout.lineBuffered((s) => stdout.push(s)),
		work
	];
	const wasi = new WASI(["geolibre", ...argv], [], fds, { debug: false });
	const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
	let exitCode = 0;
	try {
		exitCode = wasi.start(inst);
	} catch (e) {
		if (e && e.constructor && e.constructor.name === "WASIProcExit") exitCode = e.code;
		else throw new Error(describeTrap(argv, e, stdout), { cause: e });
	}
	const files = {};
	const walk = (dir, prefix) => {
		for (const [name, entry] of dir.contents) {
			const rel = prefix ? `${prefix}/${name}` : name;
			if (entry && entry.contents) walk(entry, rel);
			else if (entry && entry.data && !(prefix === "" && inNames.has(name))) files[rel] = entry.data;
		}
	};
	walk(work.dir, "");
	return {
		exitCode,
		stdout,
		files
	};
}
/**
* Run one tool over an in-memory filesystem.
* @param {string} tool  tool id, e.g. "slope" (see {@link listTools})
* @param {object} [opts]
* @param {string[]} [opts.args]  CLI args, e.g. ["--input=/work/dem.tif","--output=/work/out.tif","--units=degrees"]
* @param {Object<string, Uint8Array>} [opts.input]  files placed under /work (key = filename)
* @returns {Promise<{exitCode:number, stdout:string[], files:Object<string,Uint8Array>}>}
*   `files` contains any new files the tool wrote (e.g. the --output path).
*/
async function runTool(tool, opts = {}) {
	const { args = [], input = {} } = opts;
	if (tool === OSM_DOWNLOAD_TOOL_ID) return runOsmDownloadTool(args, input);
	if (tool === COG_SUBSET_TOOL_ID) return runCogSubsetTool(args, input);
	if (tool === WMS_SUBSET_TOOL_ID) return runWmsSubsetTool(args);
	if (tool === XYZ_SUBSET_TOOL_ID) return runXyzTileSubsetTool(args);
	if (tool === PMTILES_EXTRACT_TOOL_ID) return runPmtilesExtractTool(args, input);
	return exec([tool, ...args], input);
}
const OSM_FILTER_PRESETS = {
	all: [],
	roads: ["[highway]"],
	buildings: ["[building]"],
	water: ["[waterway]", "[natural=water]"],
	landuse: ["[landuse]"],
	trails: [
		"[highway=path]",
		"[highway=footway]",
		"[highway=cycleway]",
		"[highway=bridleway]"
	],
	parks: [
		"[leisure=park]",
		"[boundary=national_park]",
		"[landuse=recreation_ground]",
		"[leisure=nature_reserve]"
	],
	rail: ["[railway]"],
	amenities: ["[amenity]"],
	boundaries: ["[boundary]"],
	transit: [
		"[public_transport]",
		"[railway=station]",
		"[highway=bus_stop]"
	],
	poi: [
		"[amenity]",
		"[tourism]",
		"[shop]",
		"[leisure]"
	]
};
function flagBoolean(value, fallback) {
	if (value == null) return fallback;
	return value === true || String(value).toLowerCase() === "true";
}
function osmFilters(flags) {
	const tags = String(flags.include_tags ?? flags.filter_key ?? "").split(";").map((v) => v.trim()).filter(Boolean);
	const pairs = String(flags.include_key_values ?? flags.filter_key_value ?? "").split(";").map((v) => v.trim()).filter(Boolean);
	if (!tags.length && !pairs.length) {
		const preset = String(flags.filter_preset ?? "all").toLowerCase();
		if (!Object.hasOwn(OSM_FILTER_PRESETS, preset)) throw new Error(`unsupported filter_preset: ${preset}`);
		return OSM_FILTER_PRESETS[preset];
	}
	const quote = (value) => JSON.stringify(String(value));
	const explicit = [];
	for (const key of tags) explicit.push(`[${quote(key)}]`);
	for (const pair of pairs) {
		const pos = pair.indexOf("=");
		const key = (pos < 0 ? pair : pair.slice(0, pos)).trim();
		if (!key) throw new Error("Overpass tag filters require a non-empty key");
		if (pos < 0) explicit.push(`[${quote(key)}]`);
		else explicit.push(`[${quote(key)}=${quote(pair.slice(pos + 1).trim())}]`);
	}
	return [...new Set(explicit)].sort();
}
function positiveNumberFlag(raw, fallback, name) {
	const value = raw == null || raw === "" ? fallback : Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
	return value;
}
function positiveIntegerFlag(raw, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
	const value = positiveNumberFlag(raw, fallback, name);
	if (!Number.isInteger(value)) throw new Error(`--${name} must be a positive integer`);
	if (value > maximum) throw new Error(`--${name} must not exceed ${maximum}`);
	return value;
}
function osmQuery([west, south, east, north], flags) {
	const timeout = Math.max(5, positiveNumberFlag(flags.timeout_seconds, 25, "timeout_seconds"));
	const bbox = `${south.toFixed(7)},${west.toFixed(7)},${north.toFixed(7)},${east.toFixed(7)}`;
	const nodes = flagBoolean(flags.include_points, true);
	const ways = flagBoolean(flags.include_lines, true) || flagBoolean(flags.include_polygons, true);
	const relations = flagBoolean(flags.include_polygons, true);
	const filters = osmFilters(flags);
	const effective = filters.length ? filters : [""];
	const parts = [];
	for (const filter of effective) {
		if (nodes) parts.push(`  node${filter}(${bbox});`);
		if (ways) parts.push(`  way${filter}(${bbox});`);
		if (relations) parts.push(`  relation${filter}(${bbox});`);
	}
	return `[out:json][timeout:${timeout}];\n(\n${parts.join("\n")}\n);\nout body;\n>;\nout skel qt;`;
}
function osmChunks([west, south, east, north], flags) {
	if (!flagBoolean(flags.chunk_large_aoi, true)) return [[
		west,
		south,
		east,
		north
	]];
	const maxArea = positiveNumberFlag(flags.chunk_max_area_deg2, 4, "chunk_max_area_deg2");
	const maxChunkCount = positiveIntegerFlag(flags.max_chunk_count, 64, "max_chunk_count", 1024);
	const width = east - west;
	const height = north - south;
	const area = width * height;
	if (area <= maxArea) return [[
		west,
		south,
		east,
		north
	]];
	const target = Math.max(1, Math.ceil(area / maxArea));
	const nx = Math.max(1, Math.ceil(Math.sqrt(target * (height > 1e-12 ? width / height : 1))));
	const ny = Math.max(1, Math.ceil(target / nx));
	if (nx * ny > maxChunkCount) throw new Error(`chunking would require ${nx * ny} tiles`);
	const chunks = [];
	for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) chunks.push([
		west + width * ix / nx,
		south + height * iy / ny,
		ix + 1 === nx ? east : west + width * (ix + 1) / nx,
		iy + 1 === ny ? north : south + height * (iy + 1) / ny
	]);
	return chunks;
}
async function runOsmDownloadTool(args, inputFiles) {
	const flags = parseFlagArgs(args);
	const stdout = [];
	try {
		let bbox = [
			"west",
			"south",
			"east",
			"north"
		].map((key) => Number(flags[key]));
		if (bbox.some((value) => !Number.isFinite(value))) throw new Error("west, south, east, and north must be numbers");
		const inputEpsg = Number(flags.input_extent_epsg ?? 4326);
		if (inputEpsg !== 4326) {
			await initLibrary();
			bbox = Array.from(transform_bbox_epsg(inputEpsg, 4326, Float64Array.from(bbox)));
		}
		const [west, south, east, north] = bbox;
		if (west >= east || south >= north) throw new Error("west/east or south/north extent is reversed");
		if (west < -180 || east > 180 || south < -90 || north > 90) throw new Error("extent must be within WGS84 longitude/latitude bounds");
		const endpointProfiles = {
			main: "https://overpass-api.de/api/interpreter",
			kumi: "https://overpass.kumi.systems/api/interpreter",
			fr: "https://overpass.openstreetmap.fr/api/interpreter"
		};
		const endpoint = String(flags.overpass_url || endpointProfiles[String(flags.overpass_profile ?? "main")] || endpointProfiles.main);
		const endpointUrl = new URL(endpoint);
		if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password) throw new Error("Overpass endpoints must be credential-free HTTPS URLs");
		const chunks = osmChunks(bbox, flags);
		const input = { ...inputFiles };
		const timeout = Math.max(5, positiveNumberFlag(flags.timeout_seconds, 25, "timeout_seconds"));
		const concurrency = Math.min(chunks.length, positiveIntegerFlag(flags.chunk_parallel_requests, 1, "chunk_parallel_requests", 16));
		const responses = new Array(chunks.length);
		let nextChunk = 0;
		await Promise.all(Array.from({ length: concurrency }, async () => {
			while (nextChunk < chunks.length) {
				const index = nextChunk++;
				const response = await fetchOverpass(endpoint, osmQuery(chunks[index], flags), timeout);
				responses[index] = new Uint8Array(await response.arrayBuffer());
			}
		}));
		responses.forEach((bytes, index) => {
			input[`overpass_chunk_${index}.json`] = bytes;
		});
		return exec([
			OSM_DOWNLOAD_TOOL_ID,
			...args,
			"--overpass_response_prefix=/work/overpass_chunk_"
		], input);
	} catch (error) {
		const cause = error?.cause?.message ? `: ${error.cause.message}` : "";
		stdout.push(`${String(error?.message || error)}${cause}`);
		return {
			exitCode: 1,
			stdout,
			files: {}
		};
	}
}
async function fetchOverpass(endpoint, query, timeoutSeconds) {
	let lastError;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "geolibre-wasm (https://github.com/opengeos/geolibre-rust)"
				},
				body: new URLSearchParams({ data: query }),
				signal: AbortSignal.timeout((timeoutSeconds + 5) * 1e3)
			});
			if (response.ok) return response;
			lastError = /* @__PURE__ */ new Error(`Overpass returned HTTP ${response.status}`);
			if (response.status !== 429 && response.status < 500) lastError.nonRetryable = true;
		} catch (error) {
			lastError = error;
		}
		if (lastError?.nonRetryable) throw lastError;
		if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1e3 * 2 ** attempt));
	}
	throw lastError || /* @__PURE__ */ new Error("Overpass request failed");
}
function parseFlagArgs(args) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (!token.startsWith("--")) continue;
		const stripped = token.slice(2);
		if (stripped.includes("=")) {
			const [key, ...rest] = stripped.split("=");
			out[key] = rest.join("=");
		} else if (i + 1 < args.length && !args[i + 1].startsWith("--")) out[stripped] = args[++i];
		else out[stripped] = true;
	}
	return out;
}
function parseBbox(raw) {
	const bbox = String(raw || "").split(",").map((v) => Number(v.trim()));
	if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("--bbox must be ordered as minX,minY,maxX,maxY");
	return bbox;
}
function parseOptionalNumber(raw, name) {
	if (raw == null || raw === true || String(raw).trim() === "") return void 0;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
	return value;
}
function parseOptionalInteger(raw, name) {
	if (raw == null || raw === true || String(raw).trim() === "") return void 0;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
	return value;
}
function parseOptionalEpsg(raw, name) {
	if (raw == null || raw === true || String(raw).trim() === "") return void 0;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive EPSG code`);
	return value;
}
function outputKey(path) {
	if (!path || path === true) return "subset.tif";
	return String(path).replace(/^\/work\/?/, "") || "subset.tif";
}
async function runCogSubsetTool(args, inputFiles) {
	const flags = parseFlagArgs(args);
	const url = flags.url;
	const inputPath = flags.input;
	const bbox = parseBbox(flags.bbox);
	const bboxCrs = Number(flags.bbox_crs ?? flags.bboxCrs ?? flags.crs);
	const level = parseOptionalNumber(flags.level, "level");
	const resolution = parseOptionalNumber(flags.resolution, "resolution");
	const outputCrs = parseOptionalEpsg(flags.output_crs ?? flags.outputCrs, "output_crs");
	const nodata = parseOptionalNumber(flags.nodata, "nodata");
	const key = outputKey(flags.output);
	const stdout = [];
	try {
		const bytes = await extractCogSubset(await resolveCogSubsetSource({
			url,
			inputPath,
			inputFiles
		}), {
			bbox,
			bboxCrs,
			level,
			resolution,
			outputCrs,
			nodata
		});
		stdout.push(JSON.stringify({
			output: `/work/${key}`,
			bytes: bytes.byteLength
		}));
		return {
			exitCode: 0,
			stdout,
			files: { [key]: bytes }
		};
	} catch (error) {
		stdout.push(String(error?.message || error));
		return {
			exitCode: 1,
			stdout,
			files: {}
		};
	}
}
async function runWmsSubsetTool(args) {
	const flags = parseFlagArgs(args);
	const url = flags.url;
	const layers = flags.layers;
	const styles = flags.styles;
	const bbox = parseBbox(flags.bbox);
	const bboxCrs = Number(flags.bbox_crs ?? flags.bboxCrs ?? flags.crs);
	const resolution = parseOptionalNumber(flags.resolution, "resolution");
	const width = parseOptionalInteger(flags.width, "width");
	const height = parseOptionalInteger(flags.height, "height");
	const outputCrs = parseOptionalEpsg(flags.output_crs ?? flags.outputCrs, "output_crs");
	const nodata = parseOptionalNumber(flags.nodata, "nodata");
	const format = flags.format == null || flags.format === true ? void 0 : String(flags.format);
	const version = flags.version == null || flags.version === true ? void 0 : String(flags.version);
	const key = outputKey(flags.output);
	const stdout = [];
	try {
		const bytes = await extractWmsSubset(url, {
			layers,
			styles,
			bbox,
			bboxCrs,
			resolution,
			width,
			height,
			outputCrs,
			nodata,
			format,
			version
		});
		stdout.push(JSON.stringify({
			output: `/work/${key}`,
			bytes: bytes.byteLength
		}));
		return {
			exitCode: 0,
			stdout,
			files: { [key]: bytes }
		};
	} catch (error) {
		stdout.push(String(error?.message || error));
		return {
			exitCode: 1,
			stdout,
			files: {}
		};
	}
}
async function runXyzTileSubsetTool(args) {
	const flags = parseFlagArgs(args);
	const url = flags.url;
	const zoom = parseOptionalInteger(flags.zoom, "zoom");
	const bbox = parseBbox(flags.bbox);
	const bboxCrs = Number(flags.bbox_crs ?? flags.bboxCrs ?? flags.crs);
	const resolution = parseOptionalNumber(flags.resolution, "resolution");
	const width = parseOptionalInteger(flags.width, "width");
	const height = parseOptionalInteger(flags.height, "height");
	const outputCrs = parseOptionalEpsg(flags.output_crs ?? flags.outputCrs, "output_crs");
	const tileSize = parseOptionalInteger(flags.tile_size ?? flags.tileSize, "tile_size");
	const nodata = parseOptionalNumber(flags.nodata, "nodata");
	const subdomains = flags.subdomains == null || flags.subdomains === true ? void 0 : String(flags.subdomains);
	const key = outputKey(flags.output);
	const stdout = [];
	try {
		const bytes = await extractXyzTileSubset(url, {
			zoom,
			bbox,
			bboxCrs,
			resolution,
			width,
			height,
			outputCrs,
			tileSize,
			subdomains,
			nodata
		});
		stdout.push(JSON.stringify({
			output: `/work/${key}`,
			bytes: bytes.byteLength
		}));
		return {
			exitCode: 0,
			stdout,
			files: { [key]: bytes }
		};
	} catch (error) {
		stdout.push(String(error?.message || error));
		return {
			exitCode: 1,
			stdout,
			files: {}
		};
	}
}
/**
* Extract a bbox/zoom subset of a PMTiles archive (local or remote) into a new
* self-contained archive, driving the wasm `PmtilesExtractor` with byte-range
* reads. Mirrors the COG/WMS/XYZ interception so a remote planet build is
* subset by range instead of downloaded whole. The bbox is reprojected from
* `bbox_crs` to WGS84 (what PMTiles address); `bbox_crs` defaults to 4326.
*/
async function runPmtilesExtractTool(args, inputFiles) {
	const flags = parseFlagArgs(args);
	const url = flags.url;
	const inputPath = flags.input;
	const rawBbox = parseBbox(flags.bbox);
	const bboxCrs = parseOptionalEpsg(flags.bbox_crs ?? flags.bboxCrs ?? flags.crs, "bbox_crs");
	const minZoom = clampZoom(flags.min_zoom ?? flags.minZoom, 0);
	const maxZoom = clampZoom(flags.max_zoom ?? flags.maxZoom, 30);
	const maxTiles = parseOptionalInteger(flags.max_tiles ?? flags.maxTiles, "max_tiles");
	const key = pmtilesOutputKey(flags.output);
	const stdout = [];
	try {
		await initLibrary();
		const bbox = bboxCrs && bboxCrs !== 4326 ? Array.from(transform_bbox_epsg(bboxCrs, 4326, Float64Array.from(rawBbox))) : rawBbox;
		const archive = await drivePmtilesExtractor(makeSourceReader(await resolvePmtilesSource({
			url,
			inputPath,
			inputFiles
		})), {
			bbox,
			minZoom,
			maxZoom,
			maxTiles
		});
		stdout.push(JSON.stringify({
			output: `/work/${key}`,
			bytes: archive.byteLength
		}));
		return {
			exitCode: 0,
			stdout,
			files: { [key]: archive }
		};
	} catch (error) {
		stdout.push(String(error?.message || error));
		return {
			exitCode: 1,
			stdout,
			files: {}
		};
	}
}
/**
* Drive a `PmtilesExtractor` to completion over a range reader, fetching each
* round of wanted ranges concurrently.
* @param {{range: (offset:number, length:number) => Promise<Uint8Array>}} reader
* @param {{bbox:number[], minZoom:number, maxZoom:number, maxTiles?:number}} opts
* @returns {Promise<Uint8Array>}
*/
async function drivePmtilesExtractor(reader, { bbox, minZoom, maxZoom, maxTiles }) {
	const extractor = new PmtilesExtractor(bbox[0], bbox[1], bbox[2], bbox[3], minZoom, maxZoom);
	try {
		if (maxTiles != null) extractor.set_max_tiles(maxTiles);
		while (!extractor.done) {
			const wanted = JSON.parse(extractor.wanted_json());
			if (wanted.length === 0) throw new Error("PMTiles extractor stalled: not done but nothing wanted");
			const chunks = await Promise.all(wanted.map(({ offset, length }) => reader.range(offset, length)));
			wanted.forEach(({ offset }, i) => extractor.feed(offset, chunks[i]));
		}
		return extractor.finish();
	} finally {
		extractor.free();
	}
}
/** Resolve a PMTiles source to a URL string or local bytes for makeSourceReader. */
async function resolvePmtilesSource({ url, inputPath, inputFiles }) {
	const hasUrl = url && url !== true && String(url).trim() !== "";
	if (!hasUrl && !inputPath) throw new Error("provide either --url=<http pmtiles> or --input=/work/local.pmtiles");
	if (hasUrl && inputPath) throw new Error("provide only one source: --url or --input");
	if (hasUrl) return String(url).trim();
	const key = String(inputPath).replace(/^\/work\/?/, "");
	if (!inputFiles || !(key in inputFiles)) throw new Error(`input file not found in /work: ${inputPath}`);
	return materializeInput(inputFiles[key]);
}
/** Clamp/parse a zoom flag to an integer in [0, 30], falling back to a default. */
function clampZoom(raw, fallback) {
	if (raw == null || raw === true || String(raw).trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > 30) throw new Error("zoom levels must be whole numbers in 0..=30");
	return value;
}
/** Default a PMTiles output path to extract.pmtiles, stripping the /work prefix. */
function pmtilesOutputKey(path) {
	if (!path || path === true) return "extract.pmtiles";
	return String(path).replace(/^\/work\/?/, "") || "extract.pmtiles";
}
async function resolveCogSubsetSource({ url, inputPath, inputFiles }) {
	if ((url == null || url === true || String(url).trim() === "") && !inputPath) throw new Error("provide either --url=<http COG> or --input=/work/local.tif");
	if (url && url !== true && inputPath) throw new Error("provide only one source: --url or --input");
	if (url && url !== true) return String(url).trim();
	const key = outputKey(inputPath);
	if (!inputFiles || !(key in inputFiles)) throw new Error(`input file not found in /work: ${inputPath}`);
	return materializeInput(inputFiles[key]);
}
async function fetchRange(url, offset, length, fetchOptions) {
	const end = offset + length - 1;
	const headers = new Headers(fetchOptions?.headers || {});
	headers.set("Range", `bytes=${offset}-${end}`);
	try {
		if (!headers.has("User-Agent")) headers.set("User-Agent", "Mozilla/5.0 (geolibre-wasm)");
	} catch {}
	const resp = await fetch(url, {
		...fetchOptions,
		headers
	});
	if (resp.status !== 206) throw new Error(`server must support HTTP range requests (expected 206, got ${resp.status})`);
	return new Uint8Array(await resp.arrayBuffer());
}
function makeSourceReader(source, fetchOptions) {
	if (typeof source === "string") {
		if (!/^https?:\/\//i.test(source)) throw new Error(`url must be HTTP(S), got: ${source}`);
		return {
			type: "http",
			async range(offset, length) {
				return fetchRange(source, offset, length, fetchOptions);
			}
		};
	}
	const bytes = new Uint8Array(source);
	return {
		type: "local",
		async range(offset, length) {
			if (offset < 0 || length < 0 || offset >= bytes.byteLength) throw new Error(`requested byte range ${offset}-${offset + length - 1} exceeds local COG size`);
			return bytes.slice(offset, Math.min(bytes.byteLength, offset + length));
		}
	};
}
async function openCogStream(reader, options) {
	const maxHeaderBytes = options.maxHeaderBytes ?? 8388608;
	let headerBytes = options.initialHeaderBytes ?? 262144;
	let lastError = null;
	while (headerBytes <= maxHeaderBytes) {
		const prefix = await reader.range(0, headerBytes);
		try {
			return {
				stream: new CogStream(prefix),
				headerBytes,
				header: prefix
			};
		} catch (error) {
			lastError = error;
			const message = String(error?.message || error);
			if (!/(need more header bytes|failed to fill whole buffer)/i.test(message)) throw error;
			headerBytes *= 2;
		}
	}
	throw new Error(`could not parse COG header within ${maxHeaderBytes} bytes: ${lastError}`);
}
function parseLevels(stream) {
	return JSON.parse(stream.levels_json());
}
function tiffAccess(bytes) {
	if (bytes[0] !== 73 || bytes[1] !== 73) throw new Error("only little-endian TIFF metadata is supported");
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = dv.getUint16(2, true);
	const big = magic === 43;
	if (!big && magic !== 42) throw new Error("not a TIFF header");
	return {
		dv,
		big,
		inlineBytes: big ? 8 : 4,
		firstIfdOffset: Number(big ? dv.getBigUint64(8, true) : dv.getUint32(4, true)),
		readOffset(pos) {
			return Number(big ? dv.getBigUint64(pos, true) : dv.getUint32(pos, true));
		},
		readCount(pos) {
			return Number(big ? dv.getBigUint64(pos, true) : dv.getUint16(pos, true));
		},
		writeFirstIfd(out, offset) {
			if (big) new DataView(out.buffer).setBigUint64(8, BigInt(offset), true);
			else new DataView(out.buffer).setUint32(4, offset, true);
		}
	};
}
const TIFF_TYPE_BYTES = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	12: 8,
	16: 8
};
function readTiffIfd(bytes, offset, big) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = Number(big ? dv.getBigUint64(offset, true) : dv.getUint16(offset, true));
	const countBytes = big ? 8 : 2;
	const entryBytes = big ? 20 : 12;
	const inlineBytes = big ? 8 : 4;
	const entries = [];
	for (let i = 0; i < count; i++) {
		const pos = offset + countBytes + i * entryBytes;
		const tag = dv.getUint16(pos, true);
		const type = dv.getUint16(pos + 2, true);
		const valueCount = Number(big ? dv.getBigUint64(pos + 4, true) : dv.getUint32(pos + 4, true));
		const bytesLen = valueCount * (TIFF_TYPE_BYTES[type] || 1);
		const valuePos = pos + (big ? 12 : 8);
		const valueOffset = bytesLen <= inlineBytes ? valuePos : Number(big ? dv.getBigUint64(valuePos, true) : dv.getUint32(valuePos, true));
		entries.push({
			tag,
			type,
			count: valueCount,
			bytesLen,
			valuePos,
			valueOffset
		});
	}
	const nextOffsetPos = offset + countBytes + count * entryBytes;
	return {
		count,
		entries,
		nextOffset: Number(big ? dv.getBigUint64(nextOffsetPos, true) : dv.getUint32(nextOffsetPos, true))
	};
}
function readShortTag(bytes, ifd, tag) {
	const entry = ifd.entries.find((e) => e.tag === tag);
	if (!entry || entry.type !== 3 || entry.count < 1) return void 0;
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(entry.valueOffset, true);
}
function readTagBytes(bytes, ifd, tag) {
	const entry = ifd.entries.find((e) => e.tag === tag);
	if (!entry || entry.valueOffset + entry.bytesLen > bytes.byteLength) return void 0;
	return {
		type: entry.type,
		count: entry.count,
		bytes: bytes.slice(entry.valueOffset, entry.valueOffset + entry.bytesLen)
	};
}
function parseTiffPalette(headerBytes) {
	try {
		const tiff = tiffAccess(headerBytes);
		const ifd = readTiffIfd(headerBytes, tiff.firstIfdOffset, tiff.big);
		if (readShortTag(headerBytes, ifd, 262) !== 3) return null;
		const colorMap = readTagBytes(headerBytes, ifd, 320);
		if (!colorMap || colorMap.type !== 3 || colorMap.count < 3 || colorMap.count % 3 !== 0) return null;
		return colorMap;
	} catch {
		return null;
	}
}
function writeTiffEntry(out, pos, big, tag, type, count, valueBytes, valueDataOffset) {
	const dv = new DataView(out.buffer);
	dv.setUint16(pos, tag, true);
	dv.setUint16(pos + 2, type, true);
	if (big) {
		dv.setBigUint64(pos + 4, BigInt(count), true);
		if (valueBytes.byteLength <= 8) out.set(valueBytes, pos + 12);
		else dv.setBigUint64(pos + 12, BigInt(valueDataOffset), true);
	} else {
		dv.setUint32(pos + 4, count, true);
		if (valueBytes.byteLength <= 4) out.set(valueBytes, pos + 8);
		else dv.setUint32(pos + 8, valueDataOffset, true);
	}
}
function patchTiffPalette(bytes, palette) {
	if (!palette) return bytes;
	const tiff = tiffAccess(bytes);
	const oldIfd = readTiffIfd(bytes, tiff.firstIfdOffset, tiff.big);
	const entries = oldIfd.entries.filter((e) => e.tag !== 320).sort((a, b) => a.tag - b.tag);
	const photo = entries.find((e) => e.tag === 262);
	if (!photo || photo.type !== 3 || photo.count !== 1) return bytes;
	const insertAt = entries.findIndex((e) => e.tag > 320);
	const paletteEntry = {
		tag: 320,
		type: palette.type,
		count: palette.count,
		bytes: palette.bytes
	};
	const ordered = entries.map((e) => ({
		...e,
		bytes: bytes.slice(e.valueOffset, e.valueOffset + e.bytesLen)
	}));
	ordered.splice(insertAt === -1 ? ordered.length : insertAt, 0, paletteEntry);
	const countBytes = tiff.big ? 8 : 2;
	const entryBytes = tiff.big ? 20 : 12;
	const nextBytes = tiff.big ? 8 : 4;
	const newIfdOffset = bytes.byteLength;
	const ifdBytes = countBytes + ordered.length * entryBytes + nextBytes;
	const extraStart = newIfdOffset + ifdBytes;
	let extraLen = 0;
	for (const e of ordered) if (!(e.bytes.byteLength <= tiff.inlineBytes)) extraLen += e.bytes.byteLength + extraLen % 2;
	const out = new Uint8Array(bytes.byteLength + ifdBytes + extraLen);
	out.set(bytes, 0);
	tiff.writeFirstIfd(out, newIfdOffset);
	const dv = new DataView(out.buffer);
	if (tiff.big) dv.setBigUint64(newIfdOffset, BigInt(ordered.length), true);
	else dv.setUint16(newIfdOffset, ordered.length, true);
	let extraOffset = extraStart;
	for (let i = 0; i < ordered.length; i++) {
		const e = ordered[i];
		const entryPos = newIfdOffset + countBytes + i * entryBytes;
		let valueBytes = e.bytes;
		if (e.tag === 262) valueBytes = new Uint8Array([3, 0]);
		let valueDataOffset = 0;
		if (valueBytes.byteLength > tiff.inlineBytes) {
			if ((extraOffset - extraStart) % 2) extraOffset++;
			valueDataOffset = extraOffset;
			out.set(valueBytes, valueDataOffset);
			extraOffset += valueBytes.byteLength;
		}
		writeTiffEntry(out, entryPos, tiff.big, e.tag, e.type, e.count, valueBytes, valueDataOffset);
	}
	const nextPos = newIfdOffset + countBytes + ordered.length * entryBytes;
	if (tiff.big) dv.setBigUint64(nextPos, BigInt(oldIfd.nextOffset), true);
	else dv.setUint32(nextPos, oldIfd.nextOffset, true);
	return out;
}
function selectLevelForResolution(levels, gt, datasetBbox, bbox, resolution) {
	if (resolution == null) return 0;
	if (!Number.isFinite(resolution) || resolution <= 0) throw new Error("resolution must be a positive number");
	const datasetWidth = Math.abs(datasetBbox[2] - datasetBbox[0]);
	const datasetHeight = Math.abs(datasetBbox[3] - datasetBbox[1]);
	const bboxWidth = Math.abs(bbox[2] - bbox[0]);
	const bboxHeight = Math.abs(bbox[3] - bbox[1]);
	const scaleX = bboxWidth > 0 ? datasetWidth / bboxWidth : 1;
	const scaleY = bboxHeight > 0 ? datasetHeight / bboxHeight : 1;
	const targetX = resolution * scaleX;
	const targetY = resolution * scaleY;
	let best = 0;
	let bestScore = Infinity;
	for (let i = 0; i < levels.length; i++) {
		const level = levels[i];
		const levelScaleX = level.width / levels[0].width;
		const levelScaleY = level.height / levels[0].height;
		const px = Math.abs(gt[1] / levelScaleX);
		const py = Math.abs(gt[5] / levelScaleY);
		const score = Math.abs(Math.log(px / targetX)) + Math.abs(Math.log(py / targetY));
		if (score < bestScore) {
			best = i;
			bestScore = score;
		}
	}
	return best;
}
function outputBboxForCrs(bbox, bboxCrs, outputCrs) {
	if (outputCrs == null || outputCrs === bboxCrs) return bbox.slice();
	return Array.from(transform_bbox_epsg(bboxCrs, outputCrs, bbox));
}
function reprojectSubsetNearest(stream, source, src, dst, outputCrs, nodata) {
	const fill = nodata ?? NaN;
	const out = new Float64Array(dst.width * dst.height * src.bands);
	out.fill(fill);
	const batchRows = 32;
	for (let row0 = 0; row0 < dst.height; row0 += batchRows) {
		const row1 = Math.min(dst.height, row0 + batchRows);
		const coords = new Array((row1 - row0) * dst.width * 2);
		let k = 0;
		for (let row = row0; row < row1; row++) {
			const y = dst.y0 + (row + .5) * dst.pixelHeight;
			for (let col = 0; col < dst.width; col++) {
				coords[k++] = dst.x0 + (col + .5) * dst.pixelWidth;
				coords[k++] = y;
			}
		}
		const srcCoords = stream.points_to_dataset_crs(outputCrs, coords);
		k = 0;
		for (let row = row0; row < row1; row++) for (let col = 0; col < dst.width; col++) {
			const x = srcCoords[k++];
			const y = srcCoords[k++];
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			const srcCol = Math.floor((x - src.x0) / src.pixelWidth);
			const srcRow = Math.floor((y - src.y0) / src.pixelHeight);
			if (srcCol < 0 || srcRow < 0 || srcCol >= src.width || srcRow >= src.height) continue;
			const srcPixel = (srcRow * src.width + srcCol) * src.bands;
			const dstPixel = (row * dst.width + col) * src.bands;
			for (let band = 0; band < src.bands; band++) out[dstPixel + band] = source[srcPixel + band];
		}
	}
	return out;
}
function readGeotiffInterleaved(reader) {
	const bands = reader.bands;
	const pixels = reader.width * reader.height;
	const out = new Float64Array(pixels * bands);
	for (let band = 0; band < bands; band++) {
		const values = reader.read_band_f64(band);
		for (let i = 0; i < pixels; i++) out[i * bands + band] = values[i];
	}
	return out;
}
function writeTypedCog({ data, width, height, bands, sampleFormat, bitsPerSample, geoTransform, epsg, nodata, palette }) {
	const builder = new CogBuilder(width, height, bands);
	builder.set_geo_transform(geoTransform);
	builder.set_compression("deflate");
	if (epsg != null) builder.set_epsg(epsg);
	if (nodata != null) builder.set_nodata(nodata);
	if (sampleFormat === "uint" && bitsPerSample === 8) {
		const u8 = new Uint8Array(data.length);
		const fill = nodata == null ? 0 : Math.max(0, Math.min(255, Math.round(nodata)));
		for (let i = 0; i < data.length; i++) {
			const v = data[i];
			u8[i] = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : fill;
		}
		const bytes = builder.write_u8(u8);
		return bands === 1 && palette ? patchTiffPalette(bytes, palette) : bytes;
	}
	if (sampleFormat === "ieeefloat" && bitsPerSample === 32) return builder.write_f32(Float32Array.from(data));
	if (sampleFormat === "ieeefloat" && bitsPerSample === 64) return builder.write_f64(data);
	throw new Error(`preserving source sample type is not yet supported for ${sampleFormat}/${bitsPerSample}-bit rasters`);
}
function windowFromBbox(gt, baseLevel, level, bbox) {
	const [x0, pixelWidth, rowRotation, y0, colRotation, pixelHeight] = gt;
	if (Math.abs(rowRotation) > 1e-12 || Math.abs(colRotation) > 1e-12) throw new Error("rotated/skewed COG geo-transforms are not supported");
	if (!(pixelWidth > 0) || !(pixelHeight < 0)) throw new Error("only north-up COGs with positive pixel width and negative pixel height are supported");
	const scaleX = level.width / baseLevel.width;
	const scaleY = level.height / baseLevel.height;
	const px = pixelWidth / scaleX;
	const py = pixelHeight / scaleY;
	const minCol = Math.floor((bbox[0] - x0) / px);
	const maxCol = Math.ceil((bbox[2] - x0) / px);
	const minRow = Math.floor((bbox[3] - y0) / py);
	const maxRow = Math.ceil((bbox[1] - y0) / py);
	const x = Math.max(0, Math.min(level.width, minCol));
	const y = Math.max(0, Math.min(level.height, minRow));
	const x2 = Math.max(0, Math.min(level.width, maxCol));
	const y2 = Math.max(0, Math.min(level.height, maxRow));
	if (x2 <= x || y2 <= y) throw new Error("bbox does not intersect the COG extent");
	return {
		x,
		y,
		width: x2 - x,
		height: y2 - y,
		pixelWidth: px,
		pixelHeight: py
	};
}
function dimensionsForBbox(bbox, resolution, width, height) {
	const bboxWidth = bbox[2] - bbox[0];
	const bboxHeight = bbox[3] - bbox[1];
	if (!(bboxWidth > 0) || !(bboxHeight > 0)) throw new Error("bbox dimensions must be positive");
	if (resolution != null) {
		if (!(resolution > 0)) throw new Error("resolution must be positive");
		return {
			width: Math.max(1, Math.ceil(bboxWidth / resolution)),
			height: Math.max(1, Math.ceil(bboxHeight / resolution))
		};
	}
	if (width != null && height != null) return {
		width,
		height
	};
	if (width != null) return {
		width,
		height: Math.max(1, Math.round(width * bboxHeight / bboxWidth))
	};
	if (height != null) return {
		width: Math.max(1, Math.round(height * bboxWidth / bboxHeight)),
		height
	};
	const maxDim = 1024;
	return bboxWidth >= bboxHeight ? {
		width: maxDim,
		height: Math.max(1, Math.round(maxDim * bboxHeight / bboxWidth))
	} : {
		width: Math.max(1, Math.round(maxDim * bboxWidth / bboxHeight)),
		height: maxDim
	};
}
const WEB_MERCATOR_EXTENT = 20037508.342789244;
function lonLatToTile(lon, lat, zoom) {
	const n = 2 ** zoom;
	const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
	return {
		x: Math.floor((lon + 180) / 360 * n),
		y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
	};
}
function tileMercatorBounds(x, y, zoom) {
	const n = 2 ** zoom;
	const span = WEB_MERCATOR_EXTENT * 2 / n;
	const minX = -20037508.342789244 + x * span;
	const maxY = WEB_MERCATOR_EXTENT - y * span;
	return [
		minX,
		maxY - span,
		minX + span,
		maxY
	];
}
function xyzTileUrl(template, x, y, z, subdomains) {
	const s = subdomains ? subdomains[Math.abs(x + y + z) % subdomains.length] : "";
	return template.replaceAll("{x}", String(x)).replaceAll("{y}", String(y)).replaceAll("{z}", String(z)).replaceAll("{s}", s);
}
function canvasFor(width, height) {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
	if (typeof document !== "undefined" && document.createElement) {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
	throw new Error("extract_xyz_tile_subset requires browser image decoding support");
}
async function decodeImageRgba(bytes) {
	if (typeof createImageBitmap === "undefined" || typeof Blob === "undefined") throw new Error("extract_xyz_tile_subset requires createImageBitmap support to decode PNG/JPEG tiles");
	const bitmap = await createImageBitmap(new Blob([bytes]));
	const ctx = canvasFor(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
	ctx.drawImage(bitmap, 0, 0);
	const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
	if (bitmap.close) bitmap.close();
	return {
		width: image.width,
		height: image.height,
		data: image.data
	};
}
async function fetchTileRgba(url, fetchOptions) {
	const resp = await fetch(url, fetchOptions);
	if (!resp.ok) throw new Error(`tile request failed (${resp.status}): ${url}`);
	return decodeImageRgba(new Uint8Array(await resp.arrayBuffer()));
}
function buildWmsGetMapUrl(endpoint, opts) {
	const u = new URL(endpoint);
	const version = opts.version || "1.1.1";
	const crsParam = version.startsWith("1.3") ? "CRS" : "SRS";
	const params = {
		SERVICE: "WMS",
		VERSION: version,
		REQUEST: "GetMap",
		LAYERS: opts.layers,
		STYLES: opts.styles ?? "",
		FORMAT: opts.format,
		TRANSPARENT: "FALSE",
		WIDTH: String(opts.width),
		HEIGHT: String(opts.height),
		BBOX: opts.bbox.join(","),
		[crsParam]: `EPSG:${opts.crs}`
	};
	for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
	return u.toString();
}
/**
* Request a bbox subset from a WMS GetMap endpoint and write it as a Deflate COG.
*
* The WMS response must be a GeoTIFF-compatible format, typically
* `image/geotiff` or `image/tiff`. The request CRS defaults to `bboxCrs` unless
* `outputCrs` is supplied.
*
* @param {string} url WMS endpoint URL.
* @param {object} opts
* @param {string} opts.layers WMS layer name(s), comma-separated.
* @param {string} [opts.styles] WMS style name(s), comma-separated.
* @param {[number, number, number, number]} opts.bbox [minX,minY,maxX,maxY].
* @param {number} opts.bboxCrs EPSG code of `bbox`.
* @param {number} [opts.resolution] Target output pixel size in output CRS units.
* @param {number} [opts.width] Request width in pixels; used when resolution is omitted.
* @param {number} [opts.height] Request height in pixels; used when resolution is omitted.
* @param {number} [opts.outputCrs] Optional output/request EPSG code.
* @param {string} [opts.format="image/geotiff"] WMS response format.
* @param {string} [opts.version="1.1.1"] WMS version.
* @param {number} [opts.nodata] Optional output nodata value.
* @param {RequestInit} [opts.fetchOptions] Extra fetch options for the GetMap request.
* @returns {Promise<Uint8Array>}
*/
async function extractWmsSubset(url, opts) {
	opts = opts || {};
	await initLibrary();
	const { layers, styles, bbox, bboxCrs, resolution, width, height, nodata } = opts;
	const outputCrs = opts.outputCrs ?? bboxCrs;
	const format = opts.format || "image/geotiff";
	const version = opts.version || "1.1.1";
	if (!/^https?:\/\//i.test(url)) throw new Error(`url must be HTTP(S), got: ${url}`);
	if (!layers || String(layers).trim() === "") throw new Error("opts.layers is required");
	if (!/tiff|geotiff|geotif/i.test(format)) throw new Error("extract_wms_subset requires a GeoTIFF WMS format such as image/geotiff or image/tiff");
	if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("opts.bbox must be finite and ordered [minX,minY,maxX,maxY]");
	if (!Number.isInteger(bboxCrs) || bboxCrs <= 0) throw new Error("opts.bboxCrs must be a positive EPSG code");
	if (!Number.isInteger(outputCrs) || outputCrs <= 0) throw new Error("opts.outputCrs must be a positive EPSG code");
	if (nodata != null && !Number.isFinite(nodata)) throw new Error("opts.nodata must be a finite number");
	const requestBbox = outputBboxForCrs(bbox, bboxCrs, outputCrs);
	const dims = dimensionsForBbox(requestBbox, resolution, width, height);
	const requestUrl = buildWmsGetMapUrl(url, {
		layers: String(layers),
		styles: styles == null ? "" : String(styles),
		bbox: requestBbox,
		crs: outputCrs,
		width: dims.width,
		height: dims.height,
		format,
		version
	});
	const resp = await fetch(requestUrl, opts.fetchOptions);
	const bytes = new Uint8Array(await resp.arrayBuffer());
	const contentType = resp.headers.get("content-type") || "";
	if (!resp.ok) throw new Error(`WMS GetMap failed (${resp.status}): ${new TextDecoder().decode(bytes.slice(0, 512))}`);
	if (/xml|text/i.test(contentType)) throw new Error(`WMS returned an exception instead of GeoTIFF: ${new TextDecoder().decode(bytes.slice(0, 1024))}`);
	const reader = new GeoTiffReader(bytes);
	const data = readGeotiffInterleaved(reader);
	const palette = parseTiffPalette(bytes);
	return writeTypedCog({
		data,
		width: reader.width,
		height: reader.height,
		bands: reader.bands,
		sampleFormat: reader.sample_format,
		bitsPerSample: reader.bits_per_sample,
		geoTransform: [
			requestBbox[0],
			(requestBbox[2] - requestBbox[0]) / reader.width,
			0,
			requestBbox[3],
			0,
			-(requestBbox[3] - requestBbox[1]) / reader.height
		],
		epsg: outputCrs,
		nodata: nodata ?? reader.nodata,
		palette
	});
}
/**
* Fetch XYZ raster tiles for a bbox, mosaic them, and write a Deflate RGB COG.
*
* Tiles are assumed to be in the standard XYZ Web Mercator grid (EPSG:3857).
* The output CRS defaults to `bboxCrs`.
*
* @param {string} url XYZ tile URL template with `{z}`, `{x}`, `{y}` and optional `{s}`.
* @param {object} opts
* @param {number} opts.zoom XYZ zoom level.
* @param {[number, number, number, number]} opts.bbox [minX,minY,maxX,maxY].
* @param {number} opts.bboxCrs EPSG code of `bbox`.
* @param {number} [opts.resolution] Target output pixel size in output CRS units.
* @param {number} [opts.width] Output width in pixels; used when resolution is omitted.
* @param {number} [opts.height] Output height in pixels; used when resolution is omitted.
* @param {number} [opts.outputCrs] Optional output EPSG code; defaults to bboxCrs.
* @param {number} [opts.tileSize=256] Tile size in pixels.
* @param {string} [opts.subdomains] Optional subdomain letters for `{s}`.
* @param {number} [opts.nodata] Optional output nodata/fill value for missing or transparent pixels.
* @param {RequestInit} [opts.fetchOptions] Extra fetch options for tile requests.
* @returns {Promise<Uint8Array>}
*/
async function extractXyzTileSubset(url, opts) {
	opts = opts || {};
	await initLibrary();
	const { zoom, bbox, bboxCrs, resolution, width, height, nodata, subdomains } = opts;
	const outputCrs = opts.outputCrs ?? bboxCrs;
	const tileSize = opts.tileSize ?? 256;
	if (!/^https?:\/\//i.test(url)) throw new Error(`url must be HTTP(S), got: ${url}`);
	if (!Number.isInteger(zoom) || zoom < 0 || zoom > 30) throw new Error("opts.zoom must be an integer 0-30");
	if (!Number.isInteger(tileSize) || tileSize <= 0) throw new Error("opts.tileSize must be a positive integer");
	if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("opts.bbox must be finite and ordered [minX,minY,maxX,maxY]");
	if (!Number.isInteger(bboxCrs) || bboxCrs <= 0) throw new Error("opts.bboxCrs must be a positive EPSG code");
	if (!Number.isInteger(outputCrs) || outputCrs <= 0) throw new Error("opts.outputCrs must be a positive EPSG code");
	if (nodata != null && !Number.isFinite(nodata)) throw new Error("opts.nodata must be a finite number");
	const bbox4326 = bboxCrs === 4326 ? bbox : Array.from(transform_bbox_epsg(bboxCrs, 4326, bbox));
	const n = 2 ** zoom;
	const nw = lonLatToTile(bbox4326[0], bbox4326[3], zoom);
	const se = lonLatToTile(bbox4326[2], bbox4326[1], zoom);
	const minTileX = Math.max(0, Math.min(n - 1, nw.x));
	const maxTileX = Math.max(0, Math.min(n - 1, se.x));
	const minTileY = Math.max(0, Math.min(n - 1, nw.y));
	const maxTileY = Math.max(0, Math.min(n - 1, se.y));
	if (maxTileX < minTileX || maxTileY < minTileY) throw new Error("bbox does not intersect the XYZ tile grid");
	const tileCols = maxTileX - minTileX + 1;
	const tileRows = maxTileY - minTileY + 1;
	if (tileCols * tileRows > 512) throw new Error(`bbox intersects too many tiles at zoom ${zoom}: ${tileCols * tileRows}`);
	const mosaicWidth = tileCols * tileSize;
	const mosaicHeight = tileRows * tileSize;
	const fill = nodata == null ? 0 : Math.max(0, Math.min(255, Math.round(nodata)));
	const mosaic = new Uint8Array(mosaicWidth * mosaicHeight * 4);
	for (let i = 0; i < mosaic.length; i += 4) {
		mosaic[i] = fill;
		mosaic[i + 1] = fill;
		mosaic[i + 2] = fill;
		mosaic[i + 3] = 0;
	}
	for (let ty = minTileY; ty <= maxTileY; ty++) for (let tx = minTileX; tx <= maxTileX; tx++) {
		const tile = await fetchTileRgba(xyzTileUrl(url, tx, ty, zoom, subdomains), opts.fetchOptions);
		const copyW = Math.min(tileSize, tile.width);
		const copyH = Math.min(tileSize, tile.height);
		const dstX = (tx - minTileX) * tileSize;
		const dstY = (ty - minTileY) * tileSize;
		for (let row = 0; row < copyH; row++) for (let col = 0; col < copyW; col++) {
			const src = (row * tile.width + col) * 4;
			const dst = ((dstY + row) * mosaicWidth + dstX + col) * 4;
			mosaic[dst] = tile.data[src];
			mosaic[dst + 1] = tile.data[src + 1];
			mosaic[dst + 2] = tile.data[src + 2];
			mosaic[dst + 3] = tile.data[src + 3];
		}
	}
	const mb0 = tileMercatorBounds(minTileX, maxTileY, zoom);
	const mb1 = tileMercatorBounds(maxTileX, minTileY, zoom);
	const mosaicBbox3857 = [
		mb0[0],
		mb0[1],
		mb1[2],
		mb1[3]
	];
	const mosaicPx = (mosaicBbox3857[2] - mosaicBbox3857[0]) / mosaicWidth;
	const mosaicPy = -(mosaicBbox3857[3] - mosaicBbox3857[1]) / mosaicHeight;
	const outBbox = outputBboxForCrs(bbox, bboxCrs, outputCrs);
	const nativeResolution = outputCrs === 3857 ? Math.abs(mosaicPx) : Math.max((outBbox[2] - outBbox[0]) / Math.max(1, Math.round((transform_bbox_epsg(outputCrs, 3857, outBbox)[2] - transform_bbox_epsg(outputCrs, 3857, outBbox)[0]) / Math.abs(mosaicPx))), 1e-12);
	const dims = dimensionsForBbox(outBbox, resolution ?? nativeResolution, width, height);
	const out = new Float64Array(dims.width * dims.height * 3);
	const outPx = (outBbox[2] - outBbox[0]) / dims.width;
	const outPy = -(outBbox[3] - outBbox[1]) / dims.height;
	const batchRows = 32;
	for (let row0 = 0; row0 < dims.height; row0 += batchRows) {
		const row1 = Math.min(dims.height, row0 + batchRows);
		const coords = new Array((row1 - row0) * dims.width * 2);
		let k = 0;
		for (let row = row0; row < row1; row++) {
			const y = outBbox[3] + (row + .5) * outPy;
			for (let col = 0; col < dims.width; col++) {
				coords[k++] = outBbox[0] + (col + .5) * outPx;
				coords[k++] = y;
			}
		}
		const merc = outputCrs === 3857 ? coords : Array.from(transform_points_epsg(outputCrs, 3857, coords));
		k = 0;
		for (let row = row0; row < row1; row++) for (let col = 0; col < dims.width; col++) {
			const x = merc[k++];
			const y = merc[k++];
			const srcCol = Math.floor((x - mosaicBbox3857[0]) / mosaicPx);
			const srcRow = Math.floor((y - mosaicBbox3857[3]) / mosaicPy);
			const dst = (row * dims.width + col) * 3;
			if (srcCol < 0 || srcRow < 0 || srcCol >= mosaicWidth || srcRow >= mosaicHeight) {
				out[dst] = fill;
				out[dst + 1] = fill;
				out[dst + 2] = fill;
				continue;
			}
			const src = (srcRow * mosaicWidth + srcCol) * 4;
			if (mosaic[src + 3] === 0) {
				out[dst] = fill;
				out[dst + 1] = fill;
				out[dst + 2] = fill;
			} else {
				out[dst] = mosaic[src];
				out[dst + 1] = mosaic[src + 1];
				out[dst + 2] = mosaic[src + 2];
			}
		}
	}
	return writeTypedCog({
		data: out,
		width: dims.width,
		height: dims.height,
		bands: 3,
		sampleFormat: "uint",
		bitsPerSample: 8,
		geoTransform: [
			outBbox[0],
			outPx,
			0,
			outBbox[3],
			0,
			outPy
		],
		epsg: outputCrs,
		nodata
	});
}
/**
* Extract a bbox subset from a local or HTTP Cloud Optimized GeoTIFF. HTTP
* sources are read with byte-range requests, without downloading the full COG.
*
* The returned bytes are a new COG containing all bands from the selected
* source level, preserving supported source sample types. `bboxCrs` is an EPSG
* code for `bbox`; it is reprojected to the COG CRS before selecting tiles. If
* `resolution` is set and `level` is omitted, the closest available COG overview
* level is selected. If `outputCrs` is set, the extracted source window is
* reprojected to that EPSG CRS with nearest-neighbor resampling. Sources with
* user-defined projection strings default to `bboxCrs` output so the result can
* be written with standard EPSG metadata.
*
* @param {string|Uint8Array|ArrayBuffer} source HTTP(S) COG URL or local COG bytes.
* @param {object} opts
* @param {[number, number, number, number]} opts.bbox [minX,minY,maxX,maxY].
* @param {number} opts.bboxCrs EPSG code of `bbox`.
* @param {number} [opts.level] COG overview level to read; 0 is full res.
* @param {number} [opts.resolution] Target output pixel size in outputCrs units when outputCrs is set; otherwise bboxCrs units.
* @param {number} [opts.outputCrs] Optional output EPSG code.
* @param {number} [opts.nodata] Optional output nodata value.
* @param {RequestInit} [opts.fetchOptions] Extra fetch options for all requests.
* @param {number} [opts.initialHeaderBytes=262144] Initial COG header prefix size.
* @param {number} [opts.maxHeaderBytes=8388608] Maximum COG header prefix size.
* @returns {Promise<Uint8Array>}
*/
async function extractCogSubset(source, opts) {
	opts = opts || {};
	await initLibrary();
	const { bbox, bboxCrs, resolution, nodata } = opts || {};
	let { level, outputCrs } = opts || {};
	if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("opts.bbox must be [minX,minY,maxX,maxY]");
	if (bbox.some((v) => !Number.isFinite(v)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("opts.bbox must be finite and ordered min < max");
	if (!Number.isInteger(bboxCrs) || bboxCrs <= 0) throw new Error("opts.bboxCrs must be a positive EPSG code");
	if (level != null && (!Number.isInteger(level) || level < 0)) throw new Error("opts.level must be a non-negative integer");
	if (outputCrs != null && (!Number.isInteger(outputCrs) || outputCrs <= 0)) throw new Error("opts.outputCrs must be a positive EPSG code");
	if (nodata != null && !Number.isFinite(nodata)) throw new Error("opts.nodata must be a finite number");
	const reader = makeSourceReader(source, opts.fetchOptions);
	const { stream, header } = await openCogStream(reader, opts || {});
	const levels = parseLevels(stream);
	const sourcePalette = parseTiffPalette(header);
	if (outputCrs == null && stream.has_projection_string) outputCrs = bboxCrs;
	const datasetBbox = Array.from(stream.bbox_to_dataset_crs(bboxCrs, bbox));
	const requestedOutputBbox = outputBboxForCrs(bbox, bboxCrs, outputCrs);
	const gt = Array.from(stream.geo_transform());
	if (gt.length !== 6) throw new Error("COG has no affine geo-transform");
	if (level == null) level = selectLevelForResolution(levels, gt, datasetBbox, requestedOutputBbox, resolution);
	const selected = levels[level];
	if (!selected) throw new Error(`level ${level} out of range`);
	const win = windowFromBbox(gt, levels[0], selected, datasetBbox);
	const tileSpecs = JSON.parse(stream.tiles_for_window(level, win.x, win.y, win.width, win.height));
	const out = new Float64Array(win.width * win.height * selected.bands);
	const tileStride = selected.tile_width * selected.tile_height * selected.bands;
	for (const tile of tileSpecs) {
		const bytes = await reader.range(tile.offset, tile.length);
		const decoded = stream.decode_tile_f64(level, bytes);
		if (decoded.length !== tileStride) throw new Error(`decoded tile size mismatch for tile ${tile.col},${tile.row}`);
		const tileX0 = tile.col * selected.tile_width;
		const tileY0 = tile.row * selected.tile_height;
		const copyX0 = Math.max(win.x, tileX0);
		const copyY0 = Math.max(win.y, tileY0);
		const copyX1 = Math.min(win.x + win.width, tileX0 + selected.tile_width, selected.width);
		const copyY1 = Math.min(win.y + win.height, tileY0 + selected.tile_height, selected.height);
		for (let row = copyY0; row < copyY1; row++) for (let col = copyX0; col < copyX1; col++) {
			const srcPixel = ((row - tileY0) * selected.tile_width + (col - tileX0)) * selected.bands;
			const dstPixel = ((row - win.y) * win.width + (col - win.x)) * selected.bands;
			for (let band = 0; band < selected.bands; band++) out[dstPixel + band] = decoded[srcPixel + band];
		}
	}
	const subsetX0 = gt[0] + win.x * win.pixelWidth;
	const subsetY0 = gt[3] + win.y * win.pixelHeight;
	let finalData = out;
	let finalWidth = win.width;
	let finalHeight = win.height;
	let finalX0 = subsetX0;
	let finalY0 = subsetY0;
	let finalPixelWidth = win.pixelWidth;
	let finalPixelHeight = win.pixelHeight;
	let finalEpsg = !stream.has_projection_string ? stream.epsg : void 0;
	const outputNodata = nodata ?? stream.nodata;
	if (outputCrs != null) {
		const outWidth = resolution == null ? win.width : Math.max(1, Math.ceil((requestedOutputBbox[2] - requestedOutputBbox[0]) / resolution));
		const outHeight = resolution == null ? win.height : Math.max(1, Math.ceil((requestedOutputBbox[3] - requestedOutputBbox[1]) / resolution));
		const outPixelWidth = (requestedOutputBbox[2] - requestedOutputBbox[0]) / outWidth;
		const outPixelHeight = -(requestedOutputBbox[3] - requestedOutputBbox[1]) / outHeight;
		finalData = reprojectSubsetNearest(stream, out, {
			x0: subsetX0,
			y0: subsetY0,
			pixelWidth: win.pixelWidth,
			pixelHeight: win.pixelHeight,
			width: win.width,
			height: win.height,
			bands: selected.bands
		}, {
			x0: requestedOutputBbox[0],
			y0: requestedOutputBbox[3],
			pixelWidth: outPixelWidth,
			pixelHeight: outPixelHeight,
			width: outWidth,
			height: outHeight
		}, outputCrs, outputNodata);
		finalWidth = outWidth;
		finalHeight = outHeight;
		finalX0 = requestedOutputBbox[0];
		finalY0 = requestedOutputBbox[3];
		finalPixelWidth = outPixelWidth;
		finalPixelHeight = outPixelHeight;
		finalEpsg = outputCrs;
	}
	return writeTypedCog({
		data: finalData,
		width: finalWidth,
		height: finalHeight,
		bands: selected.bands,
		sampleFormat: selected.sample_format,
		bitsPerSample: selected.bits_per_sample,
		geoTransform: [
			finalX0,
			finalPixelWidth,
			0,
			finalY0,
			0,
			finalPixelHeight
		],
		epsg: finalEpsg,
		nodata: outputNodata,
		palette: sourcePalette
	});
}
//#endregion
//#region ../../packages/processing/src/wasm-tool.worker.ts
const worker = self;
worker.addEventListener("message", async (event) => {
	const { tool, args, input } = event.data;
	worker.postMessage({ ok: "ack" });
	try {
		const result = await runTool(tool, {
			args,
			input
		});
		worker.postMessage({
			ok: true,
			result
		});
	} catch (error) {
		worker.postMessage({
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}
});
//#endregion
