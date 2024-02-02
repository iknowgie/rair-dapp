/* eslint-disable no-param-reassign */
const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const config = require('../../config');
const gcp = require('../../integrations/gcp')(config);
const log = require('../../utils/logger')(module);
const { cleanStorage, textPurify } = require('../../utils/helpers');
const { User } = require('../../models');
const AppError = require('../../utils/errors/AppError');
const eFactory = require('../../utils/entityFactory');
const { RequestBuilder, Payload } = require('yoti');

exports.getAllUsers = eFactory.getAll(User);
exports.getUserById = eFactory.getOne(User);

exports.yotiVerify = async (req, res, next) => {
  try {
    const { YOTI_CLIENT_ID } = process.env;
    const { image } = req.body;

    if (!YOTI_CLIENT_ID || !image) {
      return res.json({
        success: false,
        message: 'Cannot process age verification'
      });
    }

    const data = {
      img: image,
      threshold: 25,
      operator: "OVER",
      metadata: {        
        "device": "unknown"
      }
    };

    const request = new RequestBuilder()
      .withBaseUrl('https://api.yoti.com/ai/v1')
      .withPemFilePath(path.join(__dirname, '../../', 'integrations', 'yoti', 'hotdrops.pem'))
      .withEndpoint('/age-antispoofing-verify')
      .withPayload(new Payload(data))
      .withMethod('POST')
      .withHeader('X-Yoti-Auth-Id', YOTI_CLIENT_ID)
      .build();
  
    const response = await request.execute();

    if (response.parsedResponse.age.age_check === "pass") {
      await User.findByIdAndUpdate(req.user._id, {$set: {
        ageVerified: true
      }});
      req.session.userData.ageVerified = true;
    }

    return res.json({
      success: true,
      data: response.parsedResponse
    });
  } catch (err) {
    return next(err);
  }
};

exports.listUsers = async (req, res, next) => {
  try {
    const list = await User.find({}, {
      email: 1,
      nickName: 1,
      publicAddress: 1,
      creationDate: 1,
    });
    return res.json({
      success: true,
      data: list,
    });
  } catch (err) {
    return next(err);
  }
};

exports.exportUsers = async (req, res, next) => {
  try {
    const results = await User.find({}, {
      email: 1,
      nickName: 1,
      publicAddress: 1,
      creationDate: 1,
    });
    const delimiter = ';';
    const stringData = results.reduce((result, item) => {
        const line = `${item.creationDate.toUTCString()}${delimiter}${item.nickName}${delimiter}${item.publicAddress}${delimiter}${item.email}\n`;
        return `${result}${line}`;
    }, `Creation Date${delimiter}Nickname${delimiter}Public Address${delimiter}Email\n`);
    const fileName = path.join(__dirname, `UserExport-${(new Date()).toUTCString()}.csv`);

    fs.writeFileSync(fileName, stringData);

    await res.download(fileName);

    return setTimeout(() => {
        fs.rmSync(fileName);
    }, 2000);
  } catch (err) {
    return next(err);
  }
};

// for Contract service to enrich data with User Address
exports.addUserAdressToFilterById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      next(new AppError('No user with such ID', 404));
    }
    req.query.user = user.publicAddress;
    next();
  } catch (err) {
    next(err);
  }
};

exports.createUser = async (req, res, next) => {
  try {
    let { publicAddress } = req.body;

    publicAddress = publicAddress.toLowerCase();

    const addUser = await User.create({ publicAddress });

    const user = _.omit(addUser.toObject(), ['nonce']);

    res.status(201).json({ success: true, user });
  } catch (e) {
    next(e);
  }
};
exports.getUserByAddress = async (req, res, next) => {
  try {
    const publicAddress = req.params.publicAddress.toLowerCase();
    const user = await User.findOne({ publicAddress }, { nonce: 0 });
    if (!user) {
      return next(new AppError('No User found with that Public Address', 404));
    }
    return res.status(200).json({ success: true, user });
  } catch (e) {
    return next(e);
  }
};
exports.updateUserByUserAddress = async (req, res, next) => {
  try {
    const publicAddress = req.params.publicAddress.toLowerCase();
    const foundUser = await User.findOne({ publicAddress });
    const { user } = req;
    let fieldsForUpdate = _.assign({}, req.body);

    if (!foundUser) {
      return next(new AppError('User not found.', 404));
    }

    if (publicAddress !== user.publicAddress) {
      return next(new AppError(`You have no permissions for updating user ${publicAddress}.`, 403));
    }

    if (req.files) {
      if (req.files.length) {
        const files = await Promise.all(
          _.map(req.files, async (file) => {
            try {
              const fileLink = await gcp.uploadFile(
                config.gcp.imageBucketName,
                file,
              );

              if (fileLink) {
                log.info(`File ${file.filename} has added to GCP bucket.`);

                file.link = `${config.gcp.gateway}/${config.gcp.imageBucketName}/${fileLink}`;
              }

              return file;
            } catch (err) {
              log.error(err);

              return err;
            }
          }),
        );

        _.chain(fieldsForUpdate)
          .pick(['avatar', 'background'])
          .forEach((value, key) => {
            const v = _.chain(files)
              .find((f) => f.originalname === value)
              .get('link')
              .value();

            if (v) fieldsForUpdate[key] = v;
            else delete fieldsForUpdate[key];
          })
          .value();

        fieldsForUpdate = _.pick(fieldsForUpdate, [
          'nickName',
          'avatar',
          'email',
          'background',
        ]);

        await cleanStorage(req.files);
      } else {
        fieldsForUpdate = _.pick(fieldsForUpdate, ['nickName', 'email']);
      }
    }
    if (_.isEmpty(fieldsForUpdate)) {
      return next(new AppError('Nothing to update.', 400));
    }

    if (fieldsForUpdate.nickName) {
      fieldsForUpdate.nickName = textPurify.sanitize(fieldsForUpdate.nickName);
    }

    const updatedUser = await User.findOneAndUpdate(
      { publicAddress },
      fieldsForUpdate,
      { new: true, projection: { nonce: 0 } },
    );

    req.session.userData = {
      ...req.session.userData,
      ...updatedUser,
    };

    return res.json({ success: true, user: updatedUser });
  } catch (e) {
    return next(e);
  }
};
