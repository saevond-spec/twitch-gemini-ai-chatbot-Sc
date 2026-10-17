
import EventEmitter2 from 'eventemitter2';
const bus = new EventEmitter2({ wildcard: true, delimiter: '.', maxListeners: 50 });
bus.emitAsync = function(event, ...args) {
  return new Promise((resolve) => { this.emit(event, ...args, resolve); });
};
export default bus;
