const AppError = require('./appError');

const catchAsync = (fn) => {
  return async (req,res,next) => {
    try {
      await fn(req,res,next)
    } catch (error) {
      console.error(error)
      if(typeof error=="string"){
        next(new AppError(error,500))
      }else{
        next(error)
      }
    }
  }
}

module.exports = catchAsync